#!/usr/bin/env node
/**
 * A small, dependency-free lint pass.
 *
 * Deliberately not ESLint: this project ships with zero runtime dependencies,
 * and the checks that actually matter here are project-specific invariants that
 * a generic linter would not know about — for example, that the renderer never
 * assigns untrusted strings to innerHTML, and that the hook never gains a
 * dependency it cannot resolve inside a short-lived Claude Code subprocess.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const notes = [];

function fail(file, msg) {
  problems.push(`${path.relative(root, file).replace(/\\/g, '/')}: ${msg}`);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git', 'dist', 'test-results', 'playwright-report'].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(root);
const jsFiles = files.filter((f) => /\.(js|mjs)$/.test(f));

// 1. Everything must parse. `node --check` is the real parser, not a regex.
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    fail(file, `syntax error\n    ${String(err.stderr || err.message).split('\n')[0]}`);
  }
}

// 2. The renderer must not use innerHTML. Event details carry API error text and
//    session names — untrusted strings that would become live markup.
for (const file of files.filter((f) => f.includes(path.join('src', 'renderer')) && f.endsWith('.js'))) {
  const src = fs.readFileSync(file, 'utf8');
  if (/\.innerHTML\s*=/.test(src)) fail(file, 'assigns to innerHTML — build nodes and set textContent instead');
  if (/\.outerHTML\s*=/.test(src)) fail(file, 'assigns to outerHTML');
  if (/insertAdjacentHTML/.test(src)) fail(file, 'uses insertAdjacentHTML');
}

// 3. The hook runs in a bare Node process spawned by Claude Code. It may only
//    require Node builtins and Lifeline's own shared modules.
const hookDir = path.join(root, 'src', 'hook');
for (const file of files.filter((f) => f.startsWith(hookDir) && f.endsWith('.js'))) {
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/require\(['"]([^'"]+)['"]\)/g)) {
    const spec = m[1];
    const isRelative = spec.startsWith('.');
    const isBuiltin = !isRelative && !spec.startsWith('/');
    if (isRelative) continue;
    if (isBuiltin) {
      try {
        import.meta.resolve(`node:${spec.replace(/^node:/, '')}`);
      } catch {
        fail(file, `requires '${spec}', which is not a Node builtin — the hook must stay dependency-free`);
      }
    }
  }
  // The exit code is the entire contract with Claude Code; 2 is what rewakes it.
  if (!/EXIT_REWAKE\s*=\s*2/.test(src) && file.endsWith('lifeline-hook.js')) {
    fail(file, 'EXIT_REWAKE must be 2 — that is the exit code Claude Code treats as a rewake');
  }
}

// 4. No runtime dependencies. The hook has to work wherever Claude Code runs it,
//    with no install step and no node_modules resolution.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length) {
  fail(path.join(root, 'package.json'), `runtime dependencies are not allowed: ${Object.keys(pkg.dependencies).join(', ')}`);
}

// 5. Every script package.json advertises must exist.
for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
  const m = String(cmd).match(/\b(scripts\/[\w.-]+)/);
  if (m && !fs.existsSync(path.join(root, m[1]))) {
    fail(path.join(root, 'package.json'), `script "${name}" points at missing file ${m[1]}`);
  }
}

// 6. The renderer's CSP must stay locked down; it has no reason to reach out.
const html = path.join(root, 'src', 'renderer', 'index.html');
if (fs.existsSync(html)) {
  const src = fs.readFileSync(html, 'utf8');
  if (!/Content-Security-Policy/.test(src)) fail(html, 'missing a Content-Security-Policy meta tag');
  if (/unsafe-inline|unsafe-eval/.test(src)) fail(html, 'CSP allows unsafe-inline or unsafe-eval');
  if (/<script[^>]+src=["']https?:/.test(src)) fail(html, 'loads a remote script');
}

// 7. Electron security posture. Getting any of these wrong hands the renderer
//    full Node access, which is the one mistake that matters most here.
const main = path.join(root, 'src', 'main', 'main.js');
if (fs.existsSync(main)) {
  const src = fs.readFileSync(main, 'utf8');
  if (!/contextIsolation:\s*true/.test(src)) fail(main, 'contextIsolation must be true');
  if (!/nodeIntegration:\s*false/.test(src)) fail(main, 'nodeIntegration must be false');
}

// 8. Tests must resolve paths through the shared module so LIFELINE_HOME and
//    CLAUDE_CONFIG_DIR redirection works — this is what keeps a test run from
//    reading, or rewriting, real Claude Code sessions.
for (const file of files.filter((f) => f.includes(`${path.sep}test${path.sep}`) && /\.(js|mjs)$/.test(f))) {
  const src = fs.readFileSync(file, 'utf8');
  if (/os\.homedir\(\)/.test(src) && !/LIFELINE_HOME|CLAUDE_CONFIG_DIR/.test(src)) {
    fail(file, 'reads the real home directory without redirecting LIFELINE_HOME/CLAUDE_CONFIG_DIR');
  }
}

// 9. PowerShell scripts must be ASCII, or carry a UTF-8 BOM.
//
//    Windows PowerShell 5.1 — still the default `powershell` on Windows 11 —
//    decodes a BOM-less .ps1 as ANSI. A single em-dash inside a double-quoted
//    string then terminates the string early and the whole file fails to parse
//    with "the string is missing the terminator", at the moment someone runs the
//    installer. Cheap to check, and it has already happened once.
for (const file of walk(path.join(root, 'scripts')).filter((f) => f.endsWith('.ps1'))) {
  const raw = fs.readFileSync(file);
  const hasBom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  const text = raw.toString('utf8').replace(/^﻿/, '');
  const offenders = [...new Set([...text].filter((c) => c.charCodeAt(0) > 127))];
  if (offenders.length && !hasBom) {
    fail(file, `contains non-ASCII (${offenders.join(' ')}) but has no UTF-8 BOM — PowerShell 5.1 will misparse it`);
  }
}

// Informational: flag stray debugging left behind in shipped code.
for (const file of jsFiles.filter((f) => f.startsWith(path.join(root, 'src')))) {
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  lines.forEach((l, i) => {
    if (/\bconsole\.log\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) {
      notes.push(`${path.relative(root, file).replace(/\\/g, '/')}:${i + 1}: console.log in shipped code`);
    }
  });
}

console.log(`Checked ${jsFiles.length} JavaScript files.`);

if (notes.length) {
  console.log(`\n${notes.length} note${notes.length === 1 ? '' : 's'}:`);
  notes.forEach((n) => console.log(`  - ${n}`));
}

if (problems.length) {
  console.error(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  problems.forEach((p) => console.error(`  ✗ ${p}`));
  process.exit(1);
}

console.log('\n✓ No problems found.');
