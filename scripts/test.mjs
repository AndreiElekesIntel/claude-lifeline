#!/usr/bin/env node
/**
 * Runs the unit suite.
 *
 * This exists because of a portability trap that only bites on CI. The obvious
 * form, `node --test "test/unit/*.test.js"`, relies on one of two things
 * expanding the glob:
 *
 *   - the shell, which bash does and PowerShell does not, or
 *   - `node --test` itself, which only learned to in Node 21.
 *
 * So it passed locally under bash and failed on a Windows runner with Node 20,
 * reporting "Could not find 'test/unit/*.test.js'" — a message that reads like a
 * missing directory rather than an unexpanded pattern. package.json declares
 * `engines.node: >=20`, so the fix is to stop depending on either and enumerate
 * the files here.
 *
 * Bare `node --test` is not the answer either: it discovers the Playwright specs
 * under test/e2e, which need a browser and fail outside their own runner.
 */

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const unitDir = path.join(repoRoot, 'test', 'unit');

const files = readdirSync(unitDir)
  .filter((f) => f.endsWith('.test.js'))
  .sort()
  .map((f) => path.join('test', 'unit', f));

if (files.length === 0) {
  console.error('No unit tests found in test/unit — that is a broken checkout, not a pass.');
  process.exit(1);
}

// Forward any extra arguments, so `npm test -- --test-name-pattern=ledger` works.
const extra = process.argv.slice(2);
const { status } = spawnSync(process.execPath, ['--test', ...extra, ...files], {
  cwd: repoRoot,
  stdio: 'inherit',
});

process.exit(status ?? 1);
