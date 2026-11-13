// 16 kHz mono 16-bit PCM: what the microphone recorder emits and the speech
// server expects.

export const RATE = 16000;
const BYTES_PER_SAMPLE = 2;

export const seconds = (bytes: number) => bytes / (RATE * BYTES_PER_SAMPLE);
/** The bytes of PCM that hold `duration` seconds. */
export const pcmBytes = (duration: number) => Math.round(duration * RATE) * BYTES_PER_SAMPLE;

/** Wraps raw PCM in a WAV header. */
export function wav(pcm: Buffer): Buffer {
  const data = pcm.subarray(0, pcm.length - (pcm.length % BYTES_PER_SAMPLE));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Root-mean-square level of a PCM chunk, from 0 (silence) to 1 (full scale). */
export function rms(pcm: Buffer): number {
  const samples = Math.floor(pcm.length / BYTES_PER_SAMPLE);
  if (!samples) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const sample = pcm.readInt16LE(i * BYTES_PER_SAMPLE) / 32768;
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Below this loudest-chunk level (about -46 dBFS, between room noise and quiet
 * speech) a clip held nothing worth sending.
 */
export const SILENCE = 0.005;

const BARS = "▁▂▃▄▅▆▇█";

/** A bar per level, scaled from -60 dBFS (lowest bar) to -12 dBFS (full). */
export function meter(levels: number[]): string {
  return levels.map((level) => {
    const db = 20 * Math.log10(Math.max(level, 1e-6));
    const step = Math.round(((db + 60) / 48) * (BARS.length - 1));
    return BARS[Math.min(BARS.length - 1, Math.max(0, step))];
  }).join("");
}
