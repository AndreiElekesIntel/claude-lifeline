'use strict';
/**
 * Tray icons, drawn at runtime instead of shipped as .ico files.
 *
 * Two reasons: the status colour has to change (running / paused / attention),
 * and Windows tray DPI varies per machine — generating the PNG lets us render
 * at whatever size the shell asks for and stay crisp on 4K and 100% alike.
 *
 * Hand-rolled PNG encoding (zlib is in Node core) keeps the app dependency-free.
 */

const zlib = require('zlib');

/** Status colours, chosen to stay legible on both light and dark taskbars. */
const COLOURS = {
  running: [124, 92, 255], // violet — protecting
  waiting: [56, 160, 255], // blue — idle, watching
  paused: [140, 145, 160], // grey — off duty
  attention: [255, 168, 46], // amber — needs a human
  error: [240, 72, 96], // red — something is wrong
};

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Encode straight RGBA pixels as a PNG buffer. */
function encodePNG(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour + alpha
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // no filter
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A lifeline ring: an open circle with a break at the lower right, plus a pulse
 * dot. Reads as "connection" at 16px, where detail is lost.
 */
function drawIcon(size, status) {
  const [r, g, b] = COLOURS[status] || COLOURS.running;
  const px = Buffer.alloc(size * size * 4, 0);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const outer = size * 0.44;
  const inner = size * 0.26;
  // Supersample so the curve edges stay smooth without a rasteriser.
  const SS = 3;

  const set = (x, y, alpha) => {
    if (alpha <= 0) return;
    const i = (y * size + x) * 4;
    const a = Math.min(255, Math.round(alpha * 255));
    // Source-over onto whatever is already there.
    const prev = px[i + 3] / 255;
    const na = a / 255 + prev * (1 - a / 255);
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = Math.min(255, Math.round(na * 255));
  };

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS - cx;
          const fy = y + (sy + 0.5) / SS - cy;
          const d = Math.sqrt(fx * fx + fy * fy);
          if (d > outer || d < inner) continue;
          // Break the ring in the lower-right quadrant: a lifeline with a gap.
          const ang = Math.atan2(fy, fx);
          if (ang > 0.25 && ang < 1.15) continue;
          hits++;
        }
      }
      if (hits) set(x, y, hits / (SS * SS));
    }
  }

  // Pulse dot sitting in the ring's gap.
  const dotR = size * 0.13;
  const dx = cx + Math.cos(0.7) * outer * 0.95;
  const dy = cy + Math.sin(0.7) * outer * 0.95;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const fx = x + (sx + 0.5) / SS - dx;
          const fy = y + (sy + 0.5) / SS - dy;
          if (Math.sqrt(fx * fx + fy * fy) <= dotR) hits++;
        }
      }
      if (hits) set(x, y, hits / (SS * SS));
    }
  }

  return encodePNG(size, size, px);
}

/**
 * Data URL for the same art, so a renderer can show it.
 *
 * Memoised, and now worth it: the art is drawn by supersampling every pixel nine
 * times, and there are only ever a handful of distinct size/status pairs. Before the
 * widgets this was called once per state push; each widget showing the logo turned
 * that into three redraws of identical images every five seconds, forever.
 */
const urlCache = new Map();

function iconDataUrl(size, status) {
  const key = `${size}:${status}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const url = `data:image/png;base64,${drawIcon(size, status).toString('base64')}`;
  urlCache.set(key, url);
  return url;
}

module.exports = { drawIcon, iconDataUrl, COLOURS };
