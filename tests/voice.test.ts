import assert from "node:assert/strict";
import { chmod, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { meter, RATE, rms, seconds, wav } from "../extensions/voice/audio.ts";
import { baseCode, kittyKey, TAP_MS, Trigger } from "../extensions/voice/keys.ts";
import { record } from "../extensions/voice/recorder.ts";
import { joinDictation, SpeechError, transcribe } from "../extensions/voice/speech.ts";
import { temporary } from "./helpers.ts";

test("holding the key records until release", () => {
  const trigger = new Trigger();
  assert.equal(trigger.key("press", 0), "start");
  assert.equal(trigger.key("repeat", 100), "ignore");
  assert.equal(trigger.held, true);
  assert.equal(trigger.key("release", TAP_MS + 500), "stop");
  assert.equal(trigger.active, false);
});

test("a tap latches recording until the next press, whose release is ignored", () => {
  const trigger = new Trigger();
  trigger.key("press", 0);
  assert.equal(trigger.key("release", TAP_MS - 1), "latch");
  assert.equal(trigger.latched, true);
  assert.equal(trigger.key("press", 5000), "stop");
  assert.equal(trigger.key("release", 5100), "ignore");
  // Without release events (no Kitty protocol) presses simply toggle.
  assert.equal(trigger.key("press", 6000), "start");
  assert.equal(trigger.key("press", 9000), "stop");
  assert.equal(trigger.key("press", 9500), "start");
});

test("a reset recording ignores the release of a key still held", () => {
  const trigger = new Trigger();
  trigger.key("press", 0);
  trigger.reset();
  assert.equal(trigger.key("release", 2000), "ignore");
  assert.equal(trigger.key("press", 3000), "start");
});

test("key ids map to the base codepoint Kitty reports", () => {
  assert.equal(baseCode("ctrl+space"), 32);
  assert.equal(baseCode("super+ctrl+x"), 120);
  assert.equal(baseCode("alt+Enter"), 13);
  assert.equal(baseCode("ctrl+f5"), undefined);
});

test("kittyKey reads the base key and event type whatever the modifiers", () => {
  assert.deepEqual(kittyKey("\x1b[32;5u"), { code: 32, event: "press" });
  assert.deepEqual(kittyKey("\x1b[32;5:2u"), { code: 32, event: "repeat" });
  assert.deepEqual(kittyKey("\x1b[32;5:3u"), { code: 32, event: "release" });
  // Ctrl let go first: the release reports a bare space.
  assert.deepEqual(kittyKey("\x1b[32;1:3u"), { code: 32, event: "release" });
  // Alternate keys and associated text fields.
  assert.deepEqual(kittyKey("\x1b[120:88;9:3;120u"), { code: 120, event: "release" });
  assert.equal(kittyKey(" "), undefined);
  assert.equal(kittyKey("\x1b[A"), undefined);
});

test("wav wraps PCM in a 16 kHz mono 16-bit header", () => {
  const pcm = Buffer.alloc(RATE * 2 + 1); // a stray odd byte is dropped
  const clip = wav(pcm);
  assert.equal(clip.toString("ascii", 0, 4), "RIFF");
  assert.equal(clip.toString("ascii", 8, 12), "WAVE");
  assert.equal(clip.readUInt32LE(24), RATE);
  assert.equal(clip.readUInt16LE(34), 16);
  assert.equal(clip.readUInt32LE(40), RATE * 2);
  assert.equal(clip.length, 44 + RATE * 2);
  assert.equal(seconds(RATE * 2), 1);
});

test("levels measure loudness and draw as bars", () => {
  const tone = Buffer.alloc(200);
  for (let i = 0; i < 100; i++) tone.writeInt16LE(i % 2 ? 16384 : -16384, i * 2);
  assert.equal(rms(Buffer.alloc(200)), 0);
  assert.equal(rms(tone), 0.5);
  assert.equal(meter([0, 0.01, 0.5]), "▁▄█"); // -inf, -40 and -6 dBFS
});

test("dictation joins the editor text with one space", () => {
  assert.equal(joinDictation("", "Hello."), "Hello.");
  assert.equal(joinDictation("Run the tests", "then commit."), " then commit.");
  assert.equal(joinDictation("Run the tests\n", "then commit."), "then commit.");
});

test("transcribe posts WAV and marks previews as partial", async (t) => {
  const requests: Array<{ url?: string; type?: string; bytes: number }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ url: request.url, type: request.headers["content-type"], bytes: Buffer.concat(chunks).length });
      if (request.url?.includes("fail")) return response.writeHead(500).end(JSON.stringify({ error: "model exploded" }));
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ text: "hello pi-mono", ms: 42 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  assert.deepEqual(await transcribe(url, wav(Buffer.alloc(320))), { text: "hello pi-mono", ms: 42 });
  await transcribe(url, wav(Buffer.alloc(320)), { partial: true });
  assert.deepEqual(requests, [
    { url: "/transcribe", type: "audio/wav", bytes: 44 + 320 },
    { url: "/transcribe?partial=1", type: "audio/wav", bytes: 44 + 320 },
  ]);
  await assert.rejects(transcribe(`${url}/fail`, wav(Buffer.alloc(2))), (error: Error) => error instanceof SpeechError && error.message === "model exploded");
  await assert.rejects(transcribe("http://127.0.0.1:9", wav(Buffer.alloc(2))), (error: Error) => error instanceof SpeechError && /no speech server/.test(error.message));
});

test("the recorder streams PCM until stopped and reports a microphone that fails", async (t) => {
  const dir = await temporary(t);
  // Stands in for ffmpeg: four 100 ms chunks of PCM, then waits to be stopped.
  const fake = join(dir, "ffmpeg");
  await writeFile(fake, "#!/bin/sh\nfor i in 1 2 3 4; do head -c 3200 /dev/zero; sleep 0.05; done\nexec sleep 10\n");
  await chmod(fake, 0o755);
  let live = 0;
  const levels: number[] = [];
  const recorder = record({ onLive: () => live++, onLevel: (level) => levels.push(level), onError: assert.fail }, fake);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const pcm = await recorder.stop();
  assert.equal(pcm.length, 4 * 3200);
  assert.equal(live, 1);
  assert.ok(levels.length >= 1 && levels.every((level) => level === 0));

  // A wrapper that ignores SIGTERM, whose child keeps the pipe open, still stops.
  const stubborn = join(dir, "stubborn");
  await writeFile(stubborn, "#!/bin/sh\ntrap '' TERM\nhead -c 3200 /dev/zero\nsleep 3\n");
  await chmod(stubborn, 0o755);
  const started = Date.now();
  const held = record({ onLive: () => {}, onLevel: () => {}, onError: assert.fail }, stubborn);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await held.stop()).length, 3200);
  assert.ok(Date.now() - started < 2500);

  const broken = join(dir, "broken");
  await writeFile(broken, "#!/bin/sh\necho 'Input/output error' >&2\nexit 1\n");
  await chmod(broken, 0o755);
  const message = await new Promise<string>((resolve) => record({ onLive: assert.fail, onLevel: () => {}, onError: resolve }, broken));
  assert.equal(message, "Input/output error");
});
