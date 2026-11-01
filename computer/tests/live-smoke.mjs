#!/usr/bin/env node
// Explicit live test: requires an already provisioned guest. Makes no model calls.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { defaultState, loadConfig, command, sleep, portFree } from '../lib.mjs';

const state = process.env.PI_COMPUTER_STATE ?? defaultState;
const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
const run = (...args) => command(process.execPath, [cli, '--state', state, ...args]);
const dir = await mkdtemp(join(tmpdir(), 'pc-live-'));
let tunnel;
try {
  run('wait');
  run('ssh', 'pi --version && node --version && /snap/bin/chromium --version');
  const original = join(dir, 'original.txt'), retrieved = join(dir, 'retrieved.txt');
  const content = `assistant-computer persistence ${Date.now()}\n`;
  await writeFile(original, content);
  run('put', original, '/home/assistant/workspace/lifecycle-smoke.txt');
  run('stop'); run('start', '--wait');
  run('get', '/home/assistant/workspace/lifecycle-smoke.txt', retrieved);
  assert.equal(await readFile(retrieved, 'utf8'), content);
  const c = await loadConfig(state);
  tunnel = spawn(process.execPath, [cli, '--state', state, 'desktop'], { stdio: ['ignore', 'inherit', 'inherit'] });
  const tunnelExit = new Promise((resolve, reject) => { tunnel.once('error', reject); tunnel.once('exit', (code, signal) => resolve({ code, signal })); });
  let connected = false;
  for (let i = 0; i < 30; i++) {
    const header = await new Promise(resolve => {
      const client = net.createConnection({ host: '127.0.0.1', port: c.vncPort });
      client.setTimeout(2000);
      const finish = value => { client.destroy(); resolve(value); };
      client.once('error', () => finish('')); client.once('timeout', () => finish(''));
      client.once('end', () => finish('')); client.once('close', () => finish(''));
      client.once('data', data => finish(data.toString()));
    });
    if (header.startsWith('RFB ')) { connected = true; break; }
    await sleep(500);
  }
  assert.ok(connected, 'VNC protocol was not reachable through the SSH tunnel');
  tunnel.kill('SIGTERM');
  const result = await tunnelExit;
  assert.equal(result.code, 0, 'Tunnel command did not exit cleanly');
  await portFree(c.vncPort);
  console.log('Live smoke passed: guest versions, file transfer, clean shutdown/restart, persistence, VNC tunnel, cancellation. VM left running.');
} finally {
  tunnel?.kill('SIGTERM');
  await rm(dir, { recursive: true, force: true });
}
