#!/usr/bin/env node
/**
 * Builds assets/icon.ico (and PNG variants) from the runtime icon renderer.
 *
 * The icon is generated rather than committed as a binary blob, so the installer
 * icon can never drift from the tray icon — they come from the same drawing code.
 *
 * An .ico is a directory of images; PNG-compressed entries are valid and are what
 * Windows prefers at these sizes. Sizes cover the full Windows range: 16 (tray),
 * 32 (taskbar), 48 (desktop), 64/128 (tiles), 256 (Explorer's largest).
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { drawIcon } = require(path.join(root, 'src/main/tray-icon.js'));

const SIZES = [16, 32, 48, 64, 128, 256];
const assets = path.join(root, 'assets');
fs.mkdirSync(assets, { recursive: true });

/** Pack PNG buffers into an ICO container. */
function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  // Image data starts after the header and the full directory.
  let offset = 6 + images.length * 16;

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    // 256 is stored as 0 — the field is one byte.
    entry[0] = size >= 256 ? 0 : size;
    entry[1] = size >= 256 ? 0 : size;
    entry[2] = 0; // palette colours
    entry[3] = 0; // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += png.length;
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)]);
}

const images = SIZES.map((size) => ({ size, png: drawIcon(size, 'running') }));
fs.writeFileSync(path.join(assets, 'icon.ico'), buildIco(images));
console.log(`✓ assets/icon.ico  (${SIZES.join(', ')}px)`);

// A large PNG for the README and any non-Windows packaging.
fs.writeFileSync(path.join(assets, 'icon.png'), drawIcon(512, 'running'));
console.log('✓ assets/icon.png  (512px)');

// One PNG per status, so docs can show what each tray colour means.
const statusDir = path.join(assets, 'status');
fs.mkdirSync(statusDir, { recursive: true });
for (const status of ['running', 'waiting', 'paused', 'attention', 'error']) {
  fs.writeFileSync(path.join(statusDir, `${status}.png`), drawIcon(64, status));
}
console.log('✓ assets/status/*.png');
