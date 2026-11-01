import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hostArch, validateConfig, parseChecksum, cloudConfig, guestFiles, qemuArgs, sshArgs, privateDir, withLock, qmp, running, assertStopped, backup, restore, backupNames, nodeChecksums } from '../lib.mjs';

const config = { version: 1, arch: hostArch(), cpus: 4, memoryMiB: 8192, diskGiB: 64, sshPort: 22222, vncPort: 15900 };
async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test('native architecture selection rejects unsupported hosts', () => {
  assert.equal(hostArch('arm64'), 'arm64'); assert.equal(hostArch('x64'), 'amd64');
  assert.throws(() => hostArch('riscv64'));
});
test('config rejects malformed resource and port limits', () => {
  assert.equal(validateConfig({ ...config }).cpus, 4);
  for (const change of [{ cpus: 0 }, { memoryMiB: NaN }, { diskGiB: '64' }, { sshPort: 22 }, { arch: 'other' }, { version: 2 }, { vncPort: config.sshPort }]) assert.throws(() => validateConfig({ ...config, ...change }));
});
test('checksum lookup matches exact filenames, never substrings', () => {
  const hash = 'a'.repeat(64);
  assert.equal(parseChecksum(`${hash} *image.img\n`, 'image.img'), hash);
  assert.throws(() => parseChecksum(`${hash} image.img.extra\n`, 'image.img'));
});
test('cloud seed has isolated login, pinned host identity, and root-owned files', async () => {
  const files = await guestFiles(config, '12345678');
  const text = cloudConfig({ publicKey: 'ssh-ed25519 LOGIN\n', hostPublicKey: 'ssh-ed25519 HOST\n', hostPrivateKey: 'PRIVATE\n', files });
  const cloud = JSON.parse(text.slice('#cloud-config\n'.length));
  assert.equal(cloud.ssh_pwauth, false); assert.equal(cloud.disable_root, true);
  assert.deepEqual(cloud.users.map(u => u.name), ['assistant']);
  assert.deepEqual(cloud.users[0].ssh_authorized_keys, ['ssh-ed25519 LOGIN']);
  assert.equal(cloud.ssh_keys.ed25519_private, 'PRIVATE\n');
  assert.ok(cloud.write_files.every(f => f.owner === 'root:root'));
  assert.match(files.find(f => f.path.endsWith('versions.env')).content, new RegExp(nodeChecksums[config.arch]));
  const provision = files.find(f => f.path.endsWith('provision.sh')).content;
  assert.match(provision, /--ignore-scripts/); assert.match(provision, /sha256sum --check --strict/);
  assert.ok(!text.includes('--no-sandbox'));
  assert.ok(!text.includes('/Users/admin'));
});
test('VM args expose only loopback SSH, no mounts, monitor, VNC or agent forwarding', () => {
  const args = qemuArgs('/tmp/pc', { ...config, arch: 'arm64' }, { code: '/uefi/code.fd' }, 'darwin');
  assert.equal(args[args.indexOf('-accel') + 1], 'hvf');
  assert.match(args[args.indexOf('-netdev') + 1], /hostfwd=tcp:127\.0\.0\.1:22222-:22/);
  assert.ok(!args.some(a => /virtfs|9p|spice|vnc|hostfwd.*5900/.test(a)));
  assert.equal(args[args.indexOf('-display') + 1], 'none');
  const linux = qemuArgs('/tmp/pc', { ...config, arch: 'amd64' }, { code: '/uefi/code.fd' }, 'linux');
  assert.equal(linux[linux.indexOf('-accel') + 1], 'kvm');
  assert.equal(linux[linux.indexOf('-machine') + 1], 'q35');
});
test('SSH disables user config and agents and requires pre-pinned guest host key', () => {
  const args = sshArgs('/tmp/pc', config);
  for (const option of ['IdentitiesOnly=yes', 'IdentityAgent=none', 'ForwardAgent=no', 'StrictHostKeyChecking=yes', 'GlobalKnownHostsFile=/dev/null']) assert.ok(args.includes(option));
  assert.deepEqual(args.slice(0, 2), ['-F', '/dev/null']);
});
test('state is private and rejects symlink directories', async t => {
  const dir = await temporary(t); const privatePath = join(dir, 'private');
  await privateDir(privatePath);
  assert.equal((await stat(privatePath)).mode & 0o777, 0o700);
  await symlink(privatePath, join(dir, 'link'));
  await assert.rejects(privateDir(join(dir, 'link')), /private directory/);
});
test('operation lock serializes mutations and is released after failure', async t => {
  const dir = await temporary(t);
  await withLock(dir, async () => { await assert.rejects(withLock(dir, async () => {}), /lock exists/); });
  await assert.rejects(withLock(dir, async () => { throw new Error('expected'); }), /expected/);
  await withLock(dir, async () => {});
});
test('missing QMP means stopped; live pid without QMP refuses disk mutation', async t => {
  const dir = await temporary(t); await mkdir(join(dir, 'vm'));
  assert.equal(await running(dir), null);
  await assertStopped(dir);
  await writeFile(join(dir, 'vm', 'qemu.pid'), String(process.pid));
  await assert.rejects(assertStopped(dir), /refusing to modify/);
  await writeFile(join(dir, 'vm', 'qemu.pid'), '0');
  await assert.rejects(assertStopped(dir), /Invalid QEMU pid/);
});
test('QMP handshake ignores asynchronous events and correlates command response', async t => {
  const dir = await temporary(t); await mkdir(join(dir, 'vm'));
  const server = net.createServer(socket => {
    socket.write(JSON.stringify({ QMP: { version: {} } }) + '\n');
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), message = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        socket.write(JSON.stringify({ event: 'WAKEUP' }) + '\n');
        socket.write(JSON.stringify({ id: message.id, return: message.execute === 'query-status' ? { running: true, status: 'running' } : {} }) + '\n');
      }
    });
  });
  await new Promise(resolve => server.listen(join(dir, 'vm', 'qmp.sock'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  assert.deepEqual(await qmp(dir), { running: true, status: 'running' });
  await assert.rejects(assertStopped(dir), /Stop the VM/);
});
test('backup requires age recipient and refuses unencrypted naming', async t => {
  const dir = await temporary(t);
  await assert.rejects(backup(dir, join(dir, 'backup.tar'), 'password'), /age public recipient/);
  await assert.rejects(backup(dir, join(dir, 'backup.tar'), 'age1test'), /must end/);
});
const integrationAvailable = ['age', 'age-keygen', 'qemu-img'].every(bin => spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', bin]).status === 0);
test('encrypted backup round-trip and non-overwriting restore', { skip: !integrationAvailable }, async t => {
  const dir = await temporary(t), original = join(dir, 'original'), restored = join(dir, 'restored');
  await mkdir(join(original, 'vm'), { recursive: true });
  for (const name of backupNames.filter(n => n !== 'disk.qcow2')) await writeFile(join(original, 'vm', name), name === 'config.json' ? JSON.stringify(config) : `fixture ${name}`);
  assert.equal(spawnSync('qemu-img', ['create', '-f', 'qcow2', join(original, 'vm', 'disk.qcow2'), '16M']).status, 0);
  const identity = join(dir, 'identity'); assert.equal(spawnSync('age-keygen', ['-o', identity]).status, 0);
  const key = spawnSync('age-keygen', ['-y', identity], { encoding: 'utf8' }).stdout.trim();
  const archive = join(dir, 'backup.tar.age');
  await backup(original, archive, key); await restore(restored, archive, identity);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  assert.equal(await readFile(join(restored, 'vm', 'vnc-password'), 'utf8'), 'fixture vnc-password');
  assert.equal(spawnSync('qemu-img', ['check', join(restored, 'vm', 'disk.qcow2')]).status, 0);
  await assert.rejects(restore(restored, archive, identity), /will not be overwritten/);
  await assert.rejects(backup(original, archive, key), /already exists/);
  assert.equal((await stat(archive)).mode & 0o777, 0o600);
  // Wrong-architecture restores must not leave a published, unusable VM.
  await writeFile(join(original, 'vm', 'config.json'), JSON.stringify({ ...config, arch: config.arch === 'arm64' ? 'amd64' : 'arm64' }));
  const otherArchive = join(dir, 'other.tar.age'), otherState = join(dir, 'other-state');
  await backup(original, otherArchive, key);
  await assert.rejects(restore(otherState, otherArchive, identity), /different guest architecture/);
  assert.equal(existsSync(join(otherState, 'vm')), false);
  // Reject archive paths rather than handing them to tar extraction.
  const unsafe = join(dir, 'unsafe'), unsafeArchive = join(dir, 'unsafe.tar.age');
  await writeFile(unsafe, 'not a VM backup');
  assert.equal(spawnSync('tar', ['-cf', join(dir, 'unsafe.tar'), '-C', dir, 'unsafe']).status, 0);
  assert.equal(spawnSync('age', ['-r', key, '-o', unsafeArchive, join(dir, 'unsafe.tar')]).status, 0);
  await assert.rejects(restore(join(dir, 'unsafe-state'), unsafeArchive, identity), /Unexpected backup archive/);
  assert.equal(existsSync(join(dir, 'unsafe-state', 'vm')), false);
});
