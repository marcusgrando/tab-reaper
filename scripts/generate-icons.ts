import { deflateSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dir, "..");
const outDir = path.join(root, "assets/icons");

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  const crc = crc32(chunk.subarray(4, 8 + data.length));
  view.setUint32(8 + data.length, crc, false);
  return chunk;
}

function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4 + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * stride + 1);
  }
  const compressed = deflateSync(raw, { level: 9 });

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunks = [sig, pngChunk("IHDR", ihdr), pngChunk("IDAT", compressed), pngChunk("IEND", new Uint8Array(0))];
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function roundedRectSdf(x: number, y: number, cx: number, cy: number, hw: number, hh: number, r: number): number {
  const dx = Math.abs(x - cx) - (hw - r);
  const dy = Math.abs(y - cy) - (hh - r);
  const ox = Math.max(dx, 0);
  const oy = Math.max(dy, 0);
  return Math.hypot(ox, oy) + Math.min(Math.max(dx, dy), 0) - r;
}

function samplePixel(u: number, v: number): [number, number, number, number] {
  // Normalized coordinates in [0, 1]
  const bgDist = roundedRectSdf(u, v, 0.5, 0.5, 0.46, 0.46, 0.2);
  if (bgDist > 0) return [0, 0, 0, 0];

  // Deep slate gradient background
  let r = 15 + (1 - v) * 14;
  let g = 23 + (1 - v) * 18;
  let b = 42 + (1 - v) * 24;

  // Subtle inner rim
  if (bgDist > -0.03) {
    r += 24;
    g += 32;
    b += 46;
  }

  // Top stacked tab card (dimmed / discarded tab)
  const backTab = roundedRectSdf(u, v, 0.5, 0.34, 0.27, 0.08, 0.04);
  if (backTab <= 0) {
    r = 71;
    g = 85;
    b = 105;
  }

  // Front active browser window card
  const frontCard = roundedRectSdf(u, v, 0.5, 0.57, 0.31, 0.21, 0.06);
  if (frontCard <= 0) {
    r = 241;
    g = 245;
    b = 249;
  }

  // Memory bar track inside front card
  const barTrack = roundedRectSdf(u, v, 0.5, 0.62, 0.21, 0.055, 0.03);
  if (barTrack <= 0) {
    r = 203;
    g = 213;
    b = 225;
  }

  // Emerald RAM fill bar (half budget)
  const barFill = roundedRectSdf(u, v, 0.41, 0.62, 0.12, 0.055, 0.03);
  if (barFill <= 0) {
    r = 16;
    g = 185;
    b = 129;
  }

  // Accent dot on top-left of front card
  const dot = Math.hypot(u - 0.29, v - 0.46) - 0.035;
  if (dot <= 0) {
    r = 16;
    g = 185;
    b = 129;
  }

  return [r, g, b, 255];
}

function renderIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4);
  const ss = 4; // 4x4 supersampling for crisp anti-aliased edges
  const inv = 1 / (ss * ss);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let sa = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          const [pr, pg, pb, pa] = samplePixel(u, v);
          const a = pa / 255;
          sr += pr * a;
          sg += pg * a;
          sb += pb * a;
          sa += pa;
        }
      }
      const idx = (y * size + x) * 4;
      const avgA = sa * inv;
      if (avgA > 0) {
        const norm = avgA / 255;
        rgba[idx] = Math.min(255, Math.round((sr * inv) / norm));
        rgba[idx + 1] = Math.min(255, Math.round((sg * inv) / norm));
        rgba[idx + 2] = Math.min(255, Math.round((sb * inv) / norm));
        rgba[idx + 3] = Math.min(255, Math.round(avgA));
      }
    }
  }
  return encodePng(size, size, rgba);
}

await mkdir(outDir, { recursive: true });
for (const size of [16, 48, 128]) {
  const png = renderIcon(size);
  await writeFile(path.join(outDir, `icon${size}.png`), png);
}
console.log(`Generated icons in ${outDir}`);
