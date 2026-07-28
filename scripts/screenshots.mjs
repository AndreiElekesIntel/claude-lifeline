#!/usr/bin/env node
/**
 * Regenerates docs/screenshots/.
 *
 * A Node wrapper rather than an inline env assignment in package.json, because
 * `VAR=x cmd` is not portable to cmd.exe or PowerShell — and this project targets
 * Windows first.
 */

import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(path.join(root, 'docs', 'screenshots'), { recursive: true });

const child = spawn('npx', ['playwright', 'test', 'screenshots.spec.js'], {
  cwd: root,
  env: { ...process.env, LIFELINE_SHOTS: '1' },
  stdio: 'inherit',
  shell: true,
});

child.on('exit', (code) => process.exit(code ?? 1));
