import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, chmod, copyFile, rm, lstat, rename, open } from 'node:fs/promises';
import { homedir, arch, platform } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';

export const sourceDir = dirname(fileURLToPath(import.meta.url));
export const defaultState = join(homedir(), '.local', 'state', 'pi-computer');
export const nodeChecksums = {
  arm64: '1bf1eb9ee63ffc4e5d324c0b9b62cf4a289f44332dfef9607cea1a0d9596ba6f',
  amd64: '9aa8e9d2298ab68c600bd6fb86a6c13bce11a4eca1ba9b39d79fa021755d7c37',
};
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const readyCommand = "test -s /var/lib/assistant-computer/ready && systemctl is-active --quiet assistant-display assistant-desktop assistant-vnc && timeout 2 bash -c 'exec 3<>/dev/tcp/127.0.0.1/5900; IFS= read -r -t 1 greeting <&3; [[ \"$greeting\" == RFB* ]]'";
export function hostArch(value = arch()) {
  if (value === 'arm64') return 'arm64';
  if (value === 'x64') return 'amd64';
  throw new Error(`Unsupported host architecture: ${value}`);
}
export function validateConfig(c) {
  if (c.version !== 1 || !['arm64', 'amd64'].includes(c.arch)) throw new Error('Unsupported VM configuration');
  for (const [name, min, max] of [['cpus', 1, 64], ['memoryMiB', 2048, 262144], ['diskGiB', 16, 2048], ['sshPort', 1024, 65535], ['vncPort', 1024, 65535]]) {
    if (!Number.isInteger(c[name]) || c[name] < min || c[name] > max) throw new Error(`Invalid ${name}`);
  }
  if (c.sshPort === c.vncPort) throw new Error('SSH and VNC ports must differ');
  return c;
}
export function command(bin, args, { capture = false, ...options } = {}) {
  const result = spawnSync(bin, args, { stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} exited ${result.status ?? result.signal}${capture ? `: ${result.stderr?.trim()}` : ''}`);
  return capture ? result.stdout.trim() : '';
}
export function findCommand(bin) {
  const r = spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', bin], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`Missing ${bin}; see computer/README.md`);
  return r.stdout.trim();
}
export async function privateDir(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) throw new Error(`Not an owned private directory: ${path}`);
  await chmod(path, 0o700);
}
export async function privateWrite(path, content) {
  await writeFile(path, content, { mode: 0o600, flag: 'wx' });
}
export async function withLock(state, fn) {
  await privateDir(state);
  const lock = join(state, 'operation.lock');
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another operation or stale lock exists: ${lock}. Inspect owner.json before removing it.`);
  }
  try {
    await privateWrite(join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: new Date().toISOString() }));
    return await fn();
  } finally { await rm(lock, { recursive: true, force: true }); }
}
export async function loadConfig(state) {
  return validateConfig(JSON.parse(await readFile(join(state, 'vm', 'config.json'), 'utf8')));
}
export async function checksum(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
export function parseChecksum(text, filename) {
  const line = text.split('\n').find(line => line.match(/^([a-f0-9]{64})\s+\*?(.+)$/)?.[2] === filename);
  if (!line) throw new Error(`No SHA256 checksum for ${filename}`);
  return line.slice(0, 64);
}
export function sshArgs(state, c) {
  const vm = join(state, 'vm');
  return ['-F', '/dev/null', '-i', join(vm, 'id_ed25519'), '-p', String(c.sshPort),
    '-o', 'IdentitiesOnly=yes', '-o', 'IdentityAgent=none', '-o', 'ForwardAgent=no',
    '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${join(vm, 'known_hosts')}`,
    '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3'];
}
export async function guestFiles(c, password) {
  const files = [];
  for (const name of ['provision.sh', 'display.sh', 'wait-display.sh', 'assistant-display.service', 'assistant-desktop.service', 'assistant-vnc.service']) {
    files.push({ path: name.endsWith('.service') ? `/etc/systemd/system/${name}` : `/opt/assistant-computer/${name}`,
      permissions: name.endsWith('.sh') ? '0755' : '0644', content: await readFile(join(sourceDir, 'guest', name), 'utf8') });
  }
  files.push({ path: '/opt/assistant-computer/versions.env', permissions: '0600', content: `NODE_VERSION=22.22.0\nPI_VERSION=1.0.2\nNODE_SHA256=${nodeChecksums[c.arch]}\n` });
  files.push({ path: '/opt/assistant-computer/vnc-password', permissions: '0600', content: password });
  return files;
}
export function cloudConfig({ publicKey, hostPrivateKey, hostPublicKey, files }) {
  // JSON is valid YAML; the header selects cloud-init's cloud-config handler.
  return '#cloud-config\n' + JSON.stringify({
    hostname: 'assistant-computer', manage_etc_hosts: true,
    users: [{ name: 'assistant', gecos: 'Personal assistant', groups: ['sudo'], shell: '/bin/bash', lock_passwd: true,
      sudo: ['ALL=(ALL) NOPASSWD:ALL'], ssh_authorized_keys: [publicKey.trim()] }],
    ssh_pwauth: false, disable_root: true, ssh_deletekeys: true,
    ssh_keys: { ed25519_private: hostPrivateKey, ed25519_public: hostPublicKey.trim() },
    write_files: files.map(f => ({ ...f, owner: 'root:root' })),
    runcmd: [['bash', '/opt/assistant-computer/provision.sh']],
  }, null, 2) + '\n';
}
export function qemuArgs(state, c, firmware, os = platform()) {
  validateConfig(c);
  const vm = join(state, 'vm');
  const drive = (name, suffix) => `file=${join(vm, name)},${suffix}`;
  return ['-name', 'pi-computer', '-machine', c.arch === 'arm64' ? 'virt' : 'q35',
    '-accel', os === 'darwin' ? 'hvf' : 'kvm', '-cpu', 'host', '-smp', String(c.cpus), '-m', String(c.memoryMiB),
    '-drive', `if=pflash,format=raw,readonly=on,file=${firmware.code}`,
    '-drive', drive('firmware-vars.fd', 'if=pflash,format=raw'),
    '-drive', drive('disk.qcow2', 'if=virtio,format=qcow2'),
    '-drive', drive('seed.iso', 'if=virtio,format=raw,readonly=on'),
    '-netdev', `user,id=net0,ipv6=off,hostfwd=tcp:127.0.0.1:${c.sshPort}-:22`,
    '-device', 'virtio-net-pci,netdev=net0', '-device', 'virtio-rng-pci',
    '-display', 'none', '-monitor', 'none', '-serial', `file:${join(vm, 'serial.log')}`,
    '-qmp', `unix:${join(vm, 'qmp.sock')},server=on,wait=off`, '-pidfile', join(vm, 'qemu.pid'), '-daemonize'];
}
export function findFirmware(c, qemu) {
  const roots = [resolve(dirname(qemu), '../share/qemu'), '/opt/homebrew/share/qemu', '/usr/local/share/qemu', '/usr/share/qemu', '/usr/share/AAVMF', '/usr/share/OVMF'];
  const names = c.arch === 'arm64' ? [['edk2-aarch64-code.fd', 'edk2-arm-vars.fd'], ['AAVMF_CODE.fd', 'AAVMF_VARS.fd']]
    : [['edk2-x86_64-code.fd', 'edk2-i386-vars.fd'], ['OVMF_CODE_4M.fd', 'OVMF_VARS_4M.fd'], ['OVMF_CODE.fd', 'OVMF_VARS.fd']];
  for (const root of roots) for (const [code, vars] of names) {
    if (existsSync(join(root, code)) && existsSync(join(root, vars))) return { code: join(root, code), vars: join(root, vars) };
  }
  throw new Error('UEFI firmware not found; install QEMU firmware (edk2) for the host architecture');
}
export async function qmp(state, execute = 'query-status') {
  const socketPath = join(state, 'vm', 'qmp.sock');
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '', greeted = false;
    const timer = setTimeout(() => finish(new Error('QMP timed out')), 5000);
    function finish(error, value) { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); }
    socket.on('error', finish);
    socket.on('end', () => finish(new Error('QMP closed before responding')));
    socket.on('data', data => {
      buffer += data.toString();
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'), line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let response;
        try { response = JSON.parse(line); } catch { return finish(new Error('Invalid QMP response')); }
        if (response.QMP && !greeted) { greeted = true; socket.write(JSON.stringify({ execute: 'qmp_capabilities', id: 'hello' }) + '\n'); }
        if (response.id === 'hello') {
          if (response.error) return finish(new Error(response.error.desc));
          socket.write(JSON.stringify({ execute, id: 'command' }) + '\n');
        }
        if (response.id === 'command') finish(response.error ? new Error(response.error.desc) : null, response.return);
      }
    });
  });
}
export async function running(state) {
  try { return await qmp(state); }
  catch (error) {
    if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) return null;
    throw error; // An unresponsive VM is not a stopped VM.
  }
}
export async function assertStopped(state) {
  if (await running(state)) throw new Error('Stop the VM before this operation');
  const pidPath = join(state, 'vm', 'qemu.pid');
  if (existsSync(pidPath)) {
    const pid = Number((await readFile(pidPath, 'utf8')).trim());
    if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid QEMU pid file; inspect it before proceeding');
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    throw new Error(`QMP is unavailable but pid ${pid} exists; refusing to modify VM files`);
  }
}
export async function portFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
export async function create(state, options = {}) {
  await withLock(state, async () => {
    const vm = join(state, 'vm');
    if (existsSync(vm)) throw new Error(`VM directory already exists: ${vm}; inspect incomplete creation rather than overwriting it`);
    const c = validateConfig({ version: 1, arch: hostArch(), cpus: 4, memoryMiB: 8192, diskGiB: 64, sshPort: 22222, vncPort: 15900, ...options });
    const qemu = findCommand(c.arch === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64');
    findCommand('qemu-img'); findCommand('curl'); findCommand('ssh-keygen');
    const firmware = findFirmware(c, qemu);
    if (platform() !== 'darwin') findCommand('xorriso');
    await privateDir(vm);
    try {
      const filename = `noble-server-cloudimg-${c.arch}.img`;
      const base = 'https://cloud-images.ubuntu.com/noble/current';
      command('curl', ['--proto', '=https', '--tlsv1.2', '-fL', '--retry', '3', `${base}/SHA256SUMS`, '-o', join(vm, 'SHA256SUMS')]);
      c.imageSha256 = parseChecksum(await readFile(join(vm, 'SHA256SUMS'), 'utf8'), filename);
      c.imageURL = `${base}/${filename}`;
      console.log(`Downloading ${filename}; verifying SHA256 from Canonical over HTTPS.`);
      command('curl', ['--proto', '=https', '--tlsv1.2', '-fL', '--retry', '3', c.imageURL, '-o', join(vm, 'disk.qcow2')]);
      if (await checksum(join(vm, 'disk.qcow2')) !== c.imageSha256) throw new Error('Ubuntu image checksum mismatch; the current image may have rotated. Remove only this incomplete VM and retry.');
      const imageInfo = JSON.parse(command('qemu-img', ['info', '--output=json', join(vm, 'disk.qcow2')], { capture: true }));
      if (imageInfo.format !== 'qcow2' || imageInfo['backing-filename']) throw new Error('Expected a standalone qcow2 cloud image');
      command('qemu-img', ['resize', '-f', 'qcow2', join(vm, 'disk.qcow2'), `${c.diskGiB}G`]);
      await chmod(join(vm, 'disk.qcow2'), 0o600);
      await copyFile(firmware.vars, join(vm, 'firmware-vars.fd'));
      await chmod(join(vm, 'firmware-vars.fd'), 0o600);
      for (const name of ['id_ed25519', 'guest-host-key']) command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', `pi-computer-${name}`, '-f', join(vm, name)]);
      const hostPublicKey = await readFile(join(vm, 'guest-host-key.pub'), 'utf8');
      await privateWrite(join(vm, 'known_hosts'), `[127.0.0.1]:${c.sshPort} ${hostPublicKey.trim()}\n`);
      const password = randomBytes(6).toString('base64url').slice(0, 8); // VNC authentication uses eight bytes; SSH provides encryption.
      await privateWrite(join(vm, 'vnc-password'), password + '\n');
      const seed = join(vm, 'seed'); await privateDir(seed);
      await privateWrite(join(seed, 'user-data'), cloudConfig({ publicKey: await readFile(join(vm, 'id_ed25519.pub'), 'utf8'),
        hostPrivateKey: await readFile(join(vm, 'guest-host-key'), 'utf8'), hostPublicKey, files: await guestFiles(c, password) }));
      await privateWrite(join(seed, 'meta-data'), JSON.stringify({ 'instance-id': `pi-computer-${randomUUID()}`, 'local-hostname': 'assistant-computer' }));
      if (platform() === 'darwin') command('hdiutil', ['makehybrid', '-o', join(vm, 'seed.iso'), '-iso', '-joliet', '-iso-volume-name', 'cidata', '-joliet-volume-name', 'cidata', seed]);
      else command('xorriso', ['-as', 'mkisofs', '-o', join(vm, 'seed.iso'), '-V', 'cidata', '-J', '-r', seed]);
      await chmod(join(vm, 'seed.iso'), 0o600);
      await privateWrite(join(vm, 'config.json'), JSON.stringify(c, null, 2) + '\n');
      console.log(`Created ${vm}. Run start --wait; first provisioning can take 15–30 minutes.`);
    } catch (error) { throw new Error(`${error.message}\nIncomplete VM retained at ${vm}; nothing was overwritten.`); }
  });
}
export async function start(state) {
  await withLock(state, async () => {
    const c = await loadConfig(state);
    if (c.arch !== hostArch()) throw new Error('Guest/host architectures differ. Rebuild the native guest; cross-architecture emulation is not enabled.');
    if (await running(state)) { console.log('VM is already running.'); return; }
    await assertStopped(state); await portFree(c.sshPort);
    const diskInfo = JSON.parse(command('qemu-img', ['info', '--output=json', '-f', 'qcow2', join(state, 'vm', 'disk.qcow2')], { capture: true }));
    if (diskInfo['backing-filename']) throw new Error('VM disk must not reference a backing file');
    const qemu = findCommand(c.arch === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64');
    const firmware = findFirmware(c, qemu);
    await rm(join(state, 'vm', 'qmp.sock'), { force: true });
    await rm(join(state, 'vm', 'qemu.pid'), { force: true });
    command(qemu, qemuArgs(state, c, firmware));
    console.log(`VM started; SSH on 127.0.0.1:${c.sshPort}.`);
  });
}
export async function waitReady(state, timeoutMs = 30 * 60 * 1000) {
  const c = await loadConfig(state), deadline = Date.now() + timeoutMs;
  console.log('Waiting for cloud-init and guest provisioning; serial.log records boot progress.');
  while (Date.now() < deadline) {
    if (!(await running(state))) throw new Error('VM stopped before becoming ready');
    const result = spawnSync('ssh', [...sshArgs(state, c), 'assistant@127.0.0.1', readyCommand], { stdio: 'ignore', timeout: 10000 });
    if (result.status === 0) { console.log('Guest is ready.'); return; }
    await sleep(5000);
  }
  throw new Error('Guest readiness timed out; inspect logs or ssh and read /var/log/assistant-provision.log. VM left running.');
}
export async function stop(state, force = false) {
  await withLock(state, async () => {
    if (!(await running(state))) { await assertStopped(state); console.log('VM is stopped.'); return; }
    if (force) await qmp(state, 'quit');
    else await qmp(state, 'system_powerdown');
    for (let i = 0; i < 60; i++) {
      if (!(await running(state))) {
        try { await assertStopped(state); console.log('VM stopped.'); return; }
        catch (error) { if (!error.message.includes('pid ')) throw error; }
      }
      await sleep(1000);
    }
    throw new Error('Shutdown timed out. VM left running; stop --force powers it off and may lose guest data.');
  });
}
export async function ssh(state, args = []) {
  const c = await loadConfig(state);
  if (!(await running(state))) throw new Error('VM is stopped');
  command('ssh', [...sshArgs(state, c), '-t', 'assistant@127.0.0.1', ...args]);
}
export async function desktop(state, open = false) {
  const c = await loadConfig(state);
  if (!(await running(state))) throw new Error('VM is stopped');
  await portFree(c.vncPort);
  console.log(`Connect to vnc://127.0.0.1:${c.vncPort}. Password is in ${join(state, 'vm', 'vnc-password')}.`);
  console.log('Keep this command running; Ctrl-C closes the SSH tunnel.');
  const child = spawn('ssh', [...sshArgs(state, c), '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${c.vncPort}:127.0.0.1:5900`, 'assistant@127.0.0.1'], { stdio: 'inherit' });
  let cancelled = false, viewerTimer;
  const terminate = () => { cancelled = true; child.kill('SIGTERM'); };
  process.on('SIGINT', terminate); process.on('SIGTERM', terminate);
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => code === 0 || signal || cancelled ? resolve() : reject(new Error(`SSH tunnel exited ${code}`)));
      if (open && platform() === 'darwin') viewerTimer = setTimeout(() => {
        try { if (child.exitCode === null) command('open', [`vnc://127.0.0.1:${c.vncPort}`]); }
        catch (error) { terminate(); reject(error); }
      }, 1500);
    });
  } finally { clearTimeout(viewerTimer); terminate(); process.off('SIGINT', terminate); process.off('SIGTERM', terminate); }
}

export const backupNames = ['config.json', 'disk.qcow2', 'firmware-vars.fd', 'seed.iso', 'id_ed25519', 'id_ed25519.pub', 'guest-host-key', 'guest-host-key.pub', 'known_hosts', 'vnc-password'];
export async function backup(state, destination, recipient) {
  if (!/^age1[0-9a-z]+$/.test(recipient ?? '')) throw new Error('Supply --recipient with an age public recipient (age1...)');
  destination = resolve(destination);
  if (!destination.endsWith('.tar.age')) throw new Error('Backup filename must end in .tar.age');
  if (existsSync(destination)) throw new Error('Backup destination already exists');
  findCommand('age'); findCommand('tar');
  await withLock(state, async () => {
    await assertStopped(state);
    const stage = join(state, 'backup-staging');
    if (existsSync(stage)) throw new Error(`Existing staging directory: ${stage}; inspect before removing`);
    await privateDir(stage);
    let outputCreated = false;
    try {
      command('qemu-img', ['convert', '-f', 'qcow2', '-O', 'qcow2', join(state, 'vm', 'disk.qcow2'), join(stage, 'disk.qcow2')]);
      for (const name of backupNames.filter(n => n !== 'disk.qcow2')) await copyFile(join(state, 'vm', name), join(stage, name));
      // Private temporary plaintext is removed after encryption. tar never executes a shell.
      command('tar', ['-cf', join(stage, 'backup.tar'), '-C', stage, ...backupNames]);
      const output = await open(destination, 'wx', 0o600);
      outputCreated = true;
      try { command('age', ['--recipient', recipient, join(stage, 'backup.tar')], { stdio: ['ignore', output.fd, 'inherit'] }); }
      finally { await output.close(); }
      console.log(`Encrypted backup: ${destination}`);
    } catch (error) { if (outputCreated) await rm(destination, { force: true }); throw error; }
    finally { await rm(stage, { recursive: true, force: true }); }
  });
}
export async function restore(state, archive, identity) {
  findCommand('age'); findCommand('tar');
  await withLock(state, async () => {
    if (existsSync(join(state, 'vm'))) throw new Error('Restore requires a new state directory; existing VM will not be overwritten');
    const stage = join(state, 'restore-staging');
    if (existsSync(stage)) throw new Error(`Existing staging directory: ${stage}`);
    await privateDir(stage);
    try {
      command('age', ['--decrypt', '--identity', resolve(identity), '--output', join(stage, 'backup.tar'), resolve(archive)]);
      const listed = command('tar', ['-tf', join(stage, 'backup.tar')], { capture: true }).split('\n');
      if (listed.length !== backupNames.length || new Set(listed).size !== backupNames.length || listed.some(n => !backupNames.includes(n))) throw new Error('Unexpected backup archive contents');
      // Reject links and non-regular entries before extraction; backup archives are still trusted input.
      const types = command('tar', ['-tvf', join(stage, 'backup.tar')], { capture: true }).split('\n');
      if (types.some(line => !line.startsWith('-'))) throw new Error('Backup must contain only regular files');
      const extracted = join(stage, 'extracted'); await privateDir(extracted);
      command('tar', ['-xf', join(stage, 'backup.tar'), '-C', extracted]);
      for (const name of backupNames) {
        const info = await lstat(join(extracted, name));
        if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Invalid backup entry: ${name}`);
        await chmod(join(extracted, name), 0o600);
      }
      const c = validateConfig(JSON.parse(await readFile(join(extracted, 'config.json'), 'utf8')));
      if (c.arch !== hostArch()) throw new Error('This backup has a different guest architecture. Full-disk restore is same-architecture only. Extract selected application data into a newly provisioned guest instead.');
      const diskInfo = JSON.parse(command('qemu-img', ['info', '--output=json', '-f', 'qcow2', join(extracted, 'disk.qcow2')], { capture: true }));
      if (diskInfo['backing-filename']) throw new Error('Backup disk must not reference a backing file');
      command('qemu-img', ['check', '-f', 'qcow2', join(extracted, 'disk.qcow2')]);
      const target = join(state, 'vm');
      // Publish only a complete validated restore; failures leave no partial VM.
      await rename(extracted, target);
      console.log(`Restored stopped VM at ${target}`);
    } finally { await rm(stage, { recursive: true, force: true }); }
  });
}
