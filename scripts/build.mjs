#!/usr/bin/env node
/**
 * Builds the Windows installer.
 *
 * A wrapper rather than a bare `electron-builder` call, because two things about
 * electron-builder's toolchain download fail on a stock Windows 11 box and both
 * are avoidable:
 *
 *  1. It extracts a `winCodeSign` bundle that contains macOS *symlinks*
 *     (darwin/.../libcrypto.dylib). Creating a symlink on Windows needs either
 *     Developer Mode or an elevated shell, so extraction dies with
 *     "Cannot create symbolic link : A required privilege is not held by the
 *     client" — and it retries three times before failing the build. Those files
 *     are the macOS signing toolchain; a --win build never reads them. So this
 *     pre-populates the cache with everything *except* darwin/.
 *
 *  2. Its Go helper shells out to `7za`, which it expects on PATH but npm only
 *     installs into node_modules/7zip-bin. Hence the PATH injection below.
 *
 * Neither workaround touches the app — they only make `npm run build` reproducible
 * on a machine without Developer Mode or admin rights.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Pinned by the electron-builder version in devDependencies. If a future upgrade
// wants a different bundle it will download it itself and hit the symlink error
// again — the fix is to bump this to the version named in that error message.
const WIN_CODE_SIGN = 'winCodeSign-2.6.0';

const sevenZipDir = path.join(root, 'node_modules', '7zip-bin', 'win', process.arch === 'arm64' ? 'arm64' : 'x64');
const sevenZip = path.join(sevenZipDir, '7za.exe');
const appBuilder = path.join(root, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');

const cacheRoot = process.env.ELECTRON_BUILDER_CACHE
  || path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache');
const cacheDir = path.join(cacheRoot, 'winCodeSign');
const target = path.join(cacheDir, WIN_CODE_SIGN);

/**
 * True when the cache already holds a usable bundle.
 *
 * Checked via windows-10/ rather than the directory itself: a failed extraction
 * leaves a partial directory behind, and treating that as a cache hit would
 * produce a confusing failure much later in the build.
 */
function cached() {
  return fs.existsSync(path.join(target, 'windows-10'));
}

function prepareCache() {
  if (cached()) {
    console.log(`✓ ${WIN_CODE_SIGN} already cached`);
    return;
  }
  if (!fs.existsSync(sevenZip)) {
    console.warn('! 7zip-bin not found — falling back to electron-builder\'s own download');
    return;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `${WIN_CODE_SIGN}.7z`);

  if (!fs.existsSync(archive)) {
    const url = 'https://github.com/electron-userland/electron-builder-binaries/releases/download/'
      + `${WIN_CODE_SIGN}/${WIN_CODE_SIGN}.7z`;
    console.log(`↓ ${WIN_CODE_SIGN}.7z`);
    // app-builder's downloader is used rather than fetch() because it already
    // honours the HTTP(S)_PROXY variables a corporate network requires.
    const dl = spawnSync(appBuilder, ['download', '--url', url, '--output', archive], { stdio: 'inherit' });
    if (dl.status !== 0) throw new Error(`download failed (exit ${dl.status})`);
  }

  // Extract into a temporary sibling and rename on success, so an interrupted run
  // can never leave a half-extracted tree that looks like a valid cache entry.
  const staging = `${target}.partial`;
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });

  const unpack = spawnSync(sevenZip, ['x', archive, `-o${staging}`, '-y', '-x!darwin'], { stdio: 'inherit' });
  if (unpack.status !== 0) throw new Error(`extraction failed (exit ${unpack.status})`);

  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
  console.log(`✓ ${WIN_CODE_SIGN} cached (macOS signing files skipped)`);
}

prepareCache();

const args = process.argv.slice(2);
const child = spawn('npx', ['electron-builder', ...(args.length ? args : ['--win', '--x64'])], {
  cwd: root,
  env: { ...process.env, PATH: `${process.env.PATH}${path.delimiter}${sevenZipDir}` },
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => process.exit(code ?? 1));
