import { crc32, deflateSync } from "node:zlib";

/** Public-domain X.org misc-fixed 8x13, ASCII 32-126, 13 bytes per glyph. */
const FONT = Buffer.from(`
00000000000000000000000000000010101010101010001000000000242424000000000000000000
000024247e247e24240000000000103c5050381414781000000000225224080810242a4400000000
0000304848304a443a00000000101010000000000000000000000408081010100808040000000020
10100808081010200000000024187e18240000000000000000000010107c10100000000000000000
0000000000383040000000000000007c000000000000000000000000000000103810000000020204
081020408080000000001824424242424224180000000010305010101010107c000000003c424202
041820407e000000007e0204081c0202423c00000000040c142444447e0404000000007e40405c62
0202423c000000001c2040405c6242423c000000007e0204080810102020000000003c4242423c42
42423c000000003c4242463a02020438000000000000103810000010381000000000001038100000
383040000000020408102010080402000000000000007e00007e0000000000004020100804081020
40000000003c4242020408080008000000003c42424e52564a403c0000000018244242427e424242
00000000784442447844424478000000003c424040404040423c0000000078444242424242447800
0000007e404040784040407e000000007e4040407840404040000000003c424040404e42463a0000
0000424242427e42424242000000007c101010101010107c000000001f0404040404044438000000
004244485060504844420000000040404040404040407e000000008282c6aa929282828200000000
424262524a46424242000000003c424242424242423c000000007c4242427c40404040000000003c
4242424242524a3c020000007c4242427c50484442000000003c4240403c0202423c00000000fe10
101010101010100000000042424242424242423c0000000082824444442828281000000000828282
82929292aa440000000082824428102844828200000000828244281010101010000000007e020408
102040407e000000003c202020202020203c00000000808040201008040202000000007808080808
080808780000000010284400000000000000000000000000000000000000fe000010080000000000
000000000000000000003c023e42463a000000004040405c624242625c000000000000003c424040
423c000000000202023a464242463a000000000000003c427e40423c000000001c2220207c202020
20000000000000003a444438403c423c00004040405c62424242420000000000100030101010107c
000000000004000c0404040444443800004040404448704844420000000030101010101010107c00
000000000000ec9292929282000000000000005c6242424242000000000000003c424242423c0000
00000000005c6242625c40404000000000003a4642463a02020200000000005c2220202020000000
000000003c42300c423c000000000020207c202020221c0000000000000044444444443a00000000
0000004444442828100000000000000082829292aa44000000000000004224181824420000000000
0000424242463a02423c00000000007e040810207e000000000e101008300810100e000000001010
1010101010101000000000700808100c10080870000000002454480000000000000000
`.replace(/\s+/g, ""), "hex");

export const FONT_WIDTH = 8;
export const FONT_HEIGHT = 13;
export const NEWLINE_GLYPH = "\u2588";

export type Shape = {
  cellWidth: number;
  cellHeight: number;
  frameSize: number;
};

export type RenderedFrame = {
  data: string;
  mimeType: "image/png";
  cols: number;
  rows: number;
  chars: number;
};

export function geometry(shape: Shape) {
  const cols = Math.floor(shape.frameSize / shape.cellWidth);
  const rows = Math.floor(shape.frameSize / shape.cellHeight);
  return { cols, rows, capacity: cols * rows };
}

function glyph(code: number): Buffer {
  if (code < 32 || code > 126) return FONT.subarray((63 - 32) * 13, (63 - 31) * 13);
  return FONT.subarray((code - 32) * 13, (code - 31) * 13);
}

function chunk(type: string, data: Buffer) {
  const tag = Buffer.from(type);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([tag, data])) >>> 0);
  return Buffer.concat([len, tag, data, crc]);
}

function encodePng(width: number, height: number, bits: Buffer) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 1;
  ihdr[9] = 0;
  const rowBytes = Math.ceil(width / 8);
  const raw = Buffer.alloc(height * (1 + rowBytes), 0);
  for (let y = 0; y < height; y++) bits.copy(raw, y * (1 + rowBytes) + 1, y * rowBytes, (y + 1) * rowBytes);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function setBlack(bits: Buffer, rowBytes: number, x: number, y: number) {
  bits[y * rowBytes + (x >> 3)] &= ~(0x80 >> (x & 7));
}

export function renderFrame(text: string, shape: Shape): RenderedFrame {
  const { cols, rows, capacity } = geometry(shape);
  const chars = [...text].slice(0, capacity);
  const usedRows = Math.max(1, Math.min(rows, Math.ceil(chars.length / cols) || 1));
  const width = shape.frameSize;
  const height = usedRows * shape.cellHeight;
  const rowBytes = Math.ceil(width / 8);
  const bits = Buffer.alloc(height * rowBytes, 0xff);
  for (let i = 0; i < chars.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = col * shape.cellWidth;
    const y0 = row * shape.cellHeight;
    const ch = chars[i]!;
    if (ch === NEWLINE_GLYPH) {
      for (let y = 0; y < shape.cellHeight; y++) {
        for (let x = 0; x < shape.cellWidth; x++) setBlack(bits, rowBytes, x0 + x, y0 + y);
      }
      continue;
    }
    const rows13 = glyph(ch.codePointAt(0) ?? 63);
    for (let gy = 0; gy < FONT_HEIGHT; gy++) {
      const byte = rows13[gy]!;
      for (let gx = 0; gx < FONT_WIDTH; gx++) {
        if (byte & (0x80 >> gx)) setBlack(bits, rowBytes, x0 + gx, y0 + gy);
      }
    }
  }
  return {
    data: encodePng(width, height, bits).toString("base64"),
    mimeType: "image/png",
    cols,
    rows: usedRows,
    chars: chars.length,
  };
}

export function pngSize(data: string) {
  const buf = Buffer.from(data, "base64");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes: buf.length };
}
