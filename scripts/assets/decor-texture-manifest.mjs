// Writes src/domain/materials/data/decorTextures.json: the measured properties of every existing decor
// swatch (public/textures/decors and its hd/ tier) that the universal material registry needs to
// describe them as texture assets — pixel dimensions read from the JPEG headers and file sizes.
// No image is created, changed or downloaded. Usage: node scripts/assets/decor-texture-manifest.mjs
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const previewDir = join(root, "public/textures/decors");
const hdDir = join(previewDir, "hd");

/** Width and height from the first SOFn segment of a baseline or progressive JPEG. */
function jpegSize(file) {
  const b = readFileSync(file);
  if (b[0] !== 0xff || b[1] !== 0xd8) throw new Error(`${file}: not a JPEG`);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) throw new Error(`${file}: bad marker at ${i}`);
    const marker = b[i + 1];
    const length = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + length;
  }
  throw new Error(`${file}: no SOF segment`);
}

const files = readdirSync(previewDir).filter((f) => f.endsWith(".jpg")).sort();
const out = {};
for (const file of files) {
  const preview = jpegSize(join(previewDir, file));
  const hd = jpegSize(join(hdDir, file));
  out[file] = {
    standard: [preview.width, preview.height],
    enhanced: [hd.width, hd.height],
    standardBytes: statSync(join(previewDir, file)).size,
    enhancedBytes: statSync(join(hdDir, file)).size,
  };
}
const target = join(root, "src/domain/materials/data/decorTextures.json");
writeFileSync(target, JSON.stringify({ source: "public/textures/decors (+ hd/), measured from the JPEG headers", files: out }, null, 1) + "\n");
console.log(`${files.length} decor swatches → ${target}`);
