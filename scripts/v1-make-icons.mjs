// Generates the PWA icons in web/app/icons/ (dependency-free PNG encoder).
// Usage: node scripts/v1-make-icons.mjs
import {mkdirSync, writeFileSync} from 'node:fs';
import {deflateSync} from 'node:zlib';

const CRC_TABLE = Array.from({length: 256}, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x / size, y / size);
      raw.set([r, g, b, a], y * (size * 4 + 1) + 1 + x * 4);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const BG = [16, 29, 43, 255];
const ACCENT = [255, 92, 72, 255];
const LINE = [233, 238, 245, 255];

// A play triangle over three summary lines; `pad` shrinks the drawing for the maskable safe zone.
function design(pad) {
  return (u, v) => {
    const x = (u - pad) / (1 - 2 * pad);
    const y = (v - pad) / (1 - 2 * pad);
    if (x >= 0.18 && x <= 0.5 && y >= 0.2 && y <= 0.6 && Math.abs(y - 0.4) <= (0.5 - x) * 0.62) return ACCENT;
    for (const ly of [0.28, 0.42, 0.56]) {
      if (x >= 0.56 && x <= 0.84 && Math.abs(y - ly) <= 0.035) return LINE;
    }
    if (x >= 0.18 && x <= 0.84 && Math.abs(y - 0.74) <= 0.035) return LINE;
    return BG;
  };
}

const dir = new URL('../web/app/icons/', import.meta.url);
mkdirSync(dir, {recursive: true});
writeFileSync(new URL('icon-192.png', dir), png(192, design(0.04)));
writeFileSync(new URL('icon-512.png', dir), png(512, design(0.04)));
writeFileSync(new URL('icon-maskable-512.png', dir), png(512, design(0.14)));
console.log('icons written to web/app/icons/');
