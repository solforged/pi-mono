#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';
import { defaultState, create, start, stop, running, loadConfig, waitReady, ssh, desktop, backup, restore, command, findCommand, findFirmware, hostArch, sshArgs, readyCommand } from './lib.mjs';

const usage = `Usage: assistant-computer [--state DIR] COMMAND

  doctor                              Check host prerequisites
  create [--cpus N] [--memory N]       Create native Ubuntu guest (memory in MiB)
         [--disk N] [--ssh-port N] [--vnc-port N]
  start [--wait]                      Boot; optionally wait for provisioning
  wait                               Wait up to 30 minutes for readiness
  status                             Show VM and guest readiness
  stop [--force]                     ACPI shutdown; force risks data loss
  ssh [COMMAND ...]                  Interactive shell or explicit guest command
  pi                                 Start guest Pi in its workspace
  desktop [--open]                    Foreground SSH tunnel; open Mac VNC viewer
  password                           Print local desktop password
  logs                               Show recent serial boot output
  put LOCAL GUEST-PATH                Copy into /home/assistant/workspace
  get GUEST-PATH LOCAL                Retrieve from that workspace
  backup FILE.tar.age --recipient KEY Encrypted stopped-VM backup
  restore FILE.tar.age --identity KEY Restore to a NEW state directory

No host Pi credentials, configuration, or directories are shared.
`;

function takeFlag(args, name, value = false) {
  const index = args.indexOf(name);
  if (index < 0) return value ? undefined : false;
  args.splice(index, 1);
  if (!value) return true;
  const result = args.splice(index, 1)[0];
  if (!result || result.startsWith('--')) throw new Error(`Missing value for ${name}`);
  return result;
}
function noArgs(args) { if (args.length) throw new Error(`Unexpected arguments: ${args.join(' ')}`); }
function guestPath(path) {
  if (!/^\/home\/assistant\/workspace(?:\/[a-zA-Z0-9_.-]+)*\/?$/.test(path) || path.split('/').includes('..')) throw new Error('Guest path must be under /home/assistant/workspace with simple path components');
  return path;
}
async function main() {
  process.umask(0o077);
  const args = process.argv.slice(2);
  const state = resolve(takeFlag(args, '--state', true) ?? process.env.PI_COMPUTER_STATE ?? defaultState);
  if (/[\n\r,]/.test(state)) throw new Error('State path cannot contain newlines or commas');
  if (Buffer.byteLength(join(state, 'vm', 'qmp.sock')) > 100) throw new Error('State path is too long for a portable Unix socket; choose a shorter --state directory');
  const action = args.shift() ?? 'help';
  switch (action) {
    case 'help': case '--help': console.log(usage); break;
    case 'doctor': {
      noArgs(args);
      if (!['darwin', 'linux'].includes(platform())) throw new Error('Only macOS and Linux hosts are supported');
      const architecture = hostArch();
      for (const bin of ['node', 'qemu-img', 'ssh', 'ssh-keygen', 'scp', 'curl', 'tar']) console.log(`${bin}: ${findCommand(bin)}`);
      const qemu = findCommand(architecture === 'arm64' ? 'qemu-system-aarch64' : 'qemu-system-x86_64');
      console.log(`QEMU: ${qemu}\nUEFI: ${findFirmware({ arch: architecture }, qemu).code}`);
      console.log(`Seed builder: ${findCommand(platform() === 'darwin' ? 'hdiutil' : 'xorriso')}`);
      console.log(`Architecture: ${architecture}; state: ${state}`);
      if (platform() === 'linux' && !existsSync('/dev/kvm')) throw new Error('/dev/kvm is unavailable; enable hardware virtualization and KVM');
      try { console.log(`Encrypted backup: ${findCommand('age')}`); } catch { console.log('Encrypted backup: age not installed (needed only for backup/restore)'); }
      break;
    }
    case 'create': {
      const options = {};
      for (const [flag, key] of [['--cpus', 'cpus'], ['--memory', 'memoryMiB'], ['--disk', 'diskGiB'], ['--ssh-port', 'sshPort'], ['--vnc-port', 'vncPort']]) {
        const value = takeFlag(args, flag, true);
        if (value !== undefined) options[key] = Number(value);
      }
      noArgs(args); await create(state, options); break;
    }
    case 'start': { const wait = takeFlag(args, '--wait'); noArgs(args); await start(state); if (wait) await waitReady(state); break; }
    case 'wait': noArgs(args); await waitReady(state); break;
    case 'stop': { const force = takeFlag(args, '--force'); noArgs(args); await stop(state, force); break; }
    case 'status': {
      noArgs(args);
      if (!existsSync(join(state, 'vm', 'config.json'))) { console.log(`No complete VM at ${state}`); break; }
      const c = await loadConfig(state), status = await running(state);
      console.log(`${status ? status.status : 'stopped'}; ${c.arch}, ${c.cpus} CPUs, ${c.memoryMiB} MiB RAM, ${c.diskGiB} GiB disk`);
      if (status) {
        const result = spawnSync('ssh', [...sshArgs(state, c), 'assistant@127.0.0.1', readyCommand], { stdio: 'ignore', timeout: 10000 });
        console.log(`Guest: ${result.status === 0 ? 'provisioned' : 'booting, provisioning, or unreachable; inspect logs'}`);
      }
      break;
    }
    case 'ssh': await ssh(state, args); break;
    case 'pi': noArgs(args); await ssh(state, ['cd /home/assistant/workspace && exec pi']); break;
    case 'desktop': { const open = takeFlag(args, '--open'); noArgs(args); await desktop(state, open); break; }
    case 'password': noArgs(args); process.stdout.write(await readFile(join(state, 'vm', 'vnc-password'), 'utf8')); break;
    case 'logs': {
      noArgs(args); const log = join(state, 'vm', 'serial.log');
      if (!existsSync(log)) throw new Error('No serial log yet');
      command('tail', ['-n', '100', log]); break;
    }
    case 'put': case 'get': {
      if (args.length !== 2) throw new Error(`${action} needs source and destination`);
      const c = await loadConfig(state);
      if (!(await running(state))) throw new Error('VM is stopped');
      const options = sshArgs(state, c); options[options.indexOf('-p')] = '-P';
      const remote = `assistant@127.0.0.1:${guestPath(action === 'put' ? args[1] : args[0])}`;
      // Modern OpenSSH scp uses SFTP, not a guest command shell.
      command('scp', [...options, '-r', '--', ...(action === 'put' ? [resolve(args[0]), remote] : [remote, resolve(args[1])])]); break;
    }
    case 'backup': {
      const recipient = takeFlag(args, '--recipient', true);
      if (args.length !== 1) throw new Error('backup needs one output filename');
      await backup(state, args[0], recipient); break;
    }
    case 'restore': {
      const identity = takeFlag(args, '--identity', true);
      if (args.length !== 1 || !identity) throw new Error('restore needs an archive and --identity');
      await restore(state, args[0], identity); break;
    }
    default: throw new Error(`Unknown command: ${action}\n${usage}`);
  }
}
main().catch(error => { console.error(`assistant-computer: ${error.message}`); process.exitCode = 1; });
