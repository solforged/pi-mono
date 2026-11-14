import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { attach, candidates, isClipboardFile, limits, load, shortenClipboardPaths, sniff } from "../extensions/image-paste/paths.ts";
import { longSide, thumbnail } from "../extensions/image-paste/thumbs.ts";
import { temporary } from "./helpers.ts";

// A 2×1 PNG.
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DAwPAfAAcAAf9+CLHQAAAAAElFTkSuQmCC", "base64");
const paths = (text: string) => candidates(text, "/home/me").map(({ path }) => path);

test("candidates finds image paths as terminals paste them", () => {
  assert.deepEqual(paths("/tmp/a.png"), ["/tmp/a.png"]);
  assert.deepEqual(paths("see /tmp/a.PNG and ~/b.jpeg, then 'c'"), ["/tmp/a.PNG", "/home/me/b.jpeg"]);
  assert.deepEqual(paths("/Users/me/Screen\\ Shot\\ 2026.png ok"), ["/Users/me/Screen Shot 2026.png"]);
  assert.deepEqual(paths(`'/Users/me/My Shot.png' "/x/y z.webp"`), ["/Users/me/My Shot.png", "/x/y z.webp"]);
  // macOS screenshot names contain a narrow no-break space before AM/PM.
  assert.deepEqual(paths("/d/Screenshot at 10.00.00\u202fAM.png"), []);
  assert.deepEqual(paths("/d/Screenshot\\ at\\ 10.00.00\u202fAM.png"), ["/d/Screenshot at 10.00.00\u202fAM.png"]);
  assert.deepEqual(paths("file:///tmp/a%20b.gif"), ["/tmp/a b.gif"]);
  assert.deepEqual(paths("(look at /tmp/a.png)."), ["/tmp/a.png"]);
  // Only standalone absolute paths: not relative, inside words, or other types.
  assert.deepEqual(paths("docs/a.png x/tmp/a.png /tmp/a.pdf /tmp/png"), []);
  const [hit] = candidates("x '/tmp/a.png' y", "/home/me");
  assert.deepEqual([hit.start, hit.end], [2, 14]);
});

test("sniff recognises image headers, not extensions", () => {
  assert.equal(sniff(png), "image/png");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniff(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniff(Buffer.from("not an image")), undefined);
});

test("attach numbers images after existing ones and keeps meaningful paths", async () => {
  const loader = async (path: string) => path.includes("missing") ? undefined : { data: path, mimeType: "image/png" };
  const clip = "/var/folders/T/pi-clipboard-0a1b-2c3d.png";
  const result = await attach(`${clip}\n\ncompare with /x/old.png and ${clip}; ignore /x/missing.png`, 1, loader);
  assert.equal(result?.text, "[Image #2]\n\ncompare with /x/old.png [Image #3] and [Image #2]; ignore /x/missing.png");
  assert.deepEqual(result?.images.map((image) => image.data), [clip, "/x/old.png"]);
  assert.equal(await attach("no images here /x/missing.png", 0, loader), undefined);
  const many = Array.from({ length: limits.images + 2 }, (_, i) => `/x/${i}.png`).join(" ");
  assert.equal((await attach(many, 0, loader))?.images.length, limits.images);
});

test("load reads real images and rejects impostors", async (t) => {
  const dir = await temporary(t);
  await writeFile(join(dir, "a.png"), png);
  await writeFile(join(dir, "fake.png"), "plain text");
  assert.deepEqual(await load(join(dir, "a.png")), { data: png.toString("base64"), mimeType: "image/png" });
  assert.equal(await load(join(dir, "fake.png")), undefined);
  assert.equal(await load(join(dir, "gone.png")), undefined);
  assert.equal(await load(dir), undefined);
});

test("clipboard paths shorten to links in the transcript", () => {
  assert.equal(isClipboardFile("/T/pi-clipboard-699be858-b175.png"), true);
  assert.equal(isClipboardFile("/T/shot.png"), false);
  assert.equal(shortenClipboardPaths("/var/T/pi-clipboard-ab12.png\n\nwhat is this?"),
    "[\uF03E pasted image](file:///var/T/pi-clipboard-ab12.png)\n\nwhat is this?");
  assert.equal(shortenClipboardPaths("see /T/pi-clipboard-ab12.png."), "see [\uF03E pasted image](file:///T/pi-clipboard-ab12.png).");
  assert.equal(shortenClipboardPaths("/T/shot.png"), "/T/shot.png");
});

test("thumbnails get the pixels their cells show and no more", () => {
  const box = { widthPx: 960, heightPx: 352 };
  assert.equal(longSide({ width: 3456, height: 2168 }, box), 561); // height-bound screenshot
  assert.equal(longSide({ width: 4000, height: 400 }, box), 960); // width-bound banner
  assert.equal(longSide({ width: 120, height: 80 }, box), 120); // never enlarged
  assert.equal(longSide({}, box), 960); // size unknown: the box
});

test("thumbnail shrinks images and reports the original size", { skip: process.platform !== "darwin" }, async (t) => {
  const dir = await temporary(t);
  const source = join(dir, "big.png");
  await writeFile(join(dir, "small.png"), png);
  execFileSync("/usr/bin/sips", ["-s", "format", "png", "-z", "600", "1200", join(dir, "small.png"), "--out", source], { stdio: "ignore" });
  // Fitted to the box: here its height limits it.
  const thumb = await thumbnail(source, { widthPx: 400, heightPx: 48 });
  assert.equal(thumb?.mimeType, "image/png");
  assert.deepEqual([thumb?.width, thumb?.height], [1200, 600]);
  const data = Buffer.from(thumb!.data, "base64");
  assert.deepEqual([data.readUInt32BE(16), data.readUInt32BE(20)], [96, 48]);
  assert.equal(await thumbnail(join(dir, "missing.png"), { widthPx: 96, heightPx: 96 }), undefined);
});
