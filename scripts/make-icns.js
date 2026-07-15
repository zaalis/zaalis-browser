// Génère assets/icon.icns depuis assets/logo-zaalis.png en respectant
// les marges d'icône macOS : le logo est centré sur un canvas transparent
// 1024x1024, avec ~10% de padding autour comme préconisé par la HIG.
// Sans padding, l'icône déborde des slots de Dock/Launchpad et paraît trop grosse.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const src  = path.join(root, 'assets', 'logo-zaalis.png');
const out  = path.join(root, 'assets', 'icon.icns');

if (!fs.existsSync(src)) { console.error('logo-zaalis.png introuvable'); process.exit(1); }

let png2icons;
try { png2icons = require('png2icons'); }
catch { console.error('png2icons manquant : npm install'); process.exit(1); }

// 1) sips pour redimensionner le logo à 820 max (10% de marge)
const tmp = path.join(root, 'assets', '.icon-tmp');
fs.mkdirSync(tmp, { recursive: true });
const resized = path.join(tmp, 'logo-820.png');
execFileSync('/usr/bin/sips', ['-Z', '820', src, '--out', resized], { stdio: 'pipe' });

// 2) Décodage PNG basique (couleurs 8 bits, filtres 0-4)
function readPng(p) {
  const buf = fs.readFileSync(p);
  let i = 8, ihdr = null;
  const idat = [];
  while (i < buf.length) {
    const len = buf.readUInt32BE(i);
    const type = buf.slice(i + 4, i + 8).toString('ascii');
    const data = buf.slice(i + 8, i + 8 + len);
    if (type === 'IHDR') ihdr = data;
    if (type === 'IDAT') idat.push(data);
    i += 12 + len;
  }
  const w = ihdr.readUInt32BE(0), h = ihdr.readUInt32BE(4);
  const colorType = ihdr[9];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = w * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  let s = 0, prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[s++];
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = raw[s++];
      if      (f === 1) v = (v + a) & 0xff;
      else if (f === 2) v = (v + b) & 0xff;
      else if (f === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
      row[x] = v;
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (channels === 4) { out[o]=row[x*4]; out[o+1]=row[x*4+1]; out[o+2]=row[x*4+2]; out[o+3]=row[x*4+3]; }
      else if (channels === 3) { out[o]=row[x*3]; out[o+1]=row[x*3+1]; out[o+2]=row[x*3+2]; out[o+3]=255; }
      else if (channels === 2) { out[o]=out[o+1]=out[o+2]=row[x*2]; out[o+3]=row[x*2+1]; }
      else { out[o]=out[o+1]=out[o+2]=row[x]; out[o+3]=255; }
    }
    prev = row;
  }
  return { w, h, pixels: out };
}

function writePng(p, w, h, pixels) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const sig = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([t, data])) >>> 0, 0);
    return Buffer.concat([len, t, data, crc]);
  };
  fs.writeFileSync(p, Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]));
}

const size = 1024;
const logo = readPng(resized);
const canvas = Buffer.alloc(size * size * 4);
const ox = Math.floor((size - logo.w) / 2);
const oy = Math.floor((size - logo.h) / 2);
for (let y = 0; y < logo.h; y++) {
  for (let x = 0; x < logo.w; x++) {
    const s = (y * logo.w + x) * 4;
    const d = ((y + oy) * size + (x + ox)) * 4;
    canvas[d]   = logo.pixels[s];
    canvas[d+1] = logo.pixels[s+1];
    canvas[d+2] = logo.pixels[s+2];
    canvas[d+3] = logo.pixels[s+3];
  }
}
const padded = path.join(tmp, 'logo-1024.png');
writePng(padded, size, size, canvas);

const icns = png2icons.createICNS(fs.readFileSync(padded), png2icons.BILINEAR, 0);
if (!icns) { console.error('conversion icns échouée'); process.exit(1); }
fs.writeFileSync(out, icns);
try { fs.rmSync(tmp, { recursive: true }); } catch {}
console.log('icon.icns écrit avec padding HIG');
