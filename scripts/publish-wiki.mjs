#!/usr/bin/env node
/**
 * Mirrors `docs/wiki/` to the GitHub wiki.
 *
 * The wiki is a separate git repository (`<repo>.wiki.git`) with no pull requests
 * and no CI, so editing it through the web UI puts documentation outside review.
 * Keeping the pages in `docs/wiki/` and pushing them from here means a doc change
 * arrives the same way a code change does, and the wiki becomes a rendering of
 * something reviewed rather than a second source of truth.
 *
 *   node scripts/publish-wiki.mjs            # push
 *   node scripts/publish-wiki.mjs --dry-run  # show what would change
 *
 * One manual step is unavoidable the first time: GitHub does not create
 * `<repo>.wiki.git` until a first page is saved through the web UI, and there is
 * no API for it. Until then a clone here fails with "Repository not found", which
 * this reports as the actionable instruction rather than a git error.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = process.env.WIKI_REPO || 'https://github.com/AndreiElekesIntel/claude-lifeline.wiki.git';
const SOURCE = path.join(import.meta.dirname, '..', 'docs', 'wiki');
const DRY = process.argv.includes('--dry-run');

/** git, with output surfaced only on failure — a clean run should say nothing. */
function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const pages = fs.readdirSync(SOURCE).filter((f) => f.endsWith('.md'));
if (!pages.length) {
  console.error(`No pages in ${SOURCE}. Refusing to publish an empty wiki.`);
  process.exit(1);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'lifeline-wiki-'));
try {
  try {
    git(['clone', '--depth', '1', REPO, work]);
  } catch (err) {
    const msg = String(err.stderr || err.message);
    if (/not found/i.test(msg)) {
      console.error(
        [
          'The wiki repository does not exist yet.',
          '',
          'GitHub creates it only after the first page is saved in the browser, and',
          'exposes no API for that one step. To unblock this script:',
          '',
          '  1. Open https://github.com/AndreiElekesIntel/claude-lifeline/wiki',
          '  2. Click "Create the first page" and Save (any content — it gets overwritten)',
          '  3. Re-run: npm run wiki',
          '',
          `git said: ${msg.trim().split('\n').pop()}`,
        ].join('\n')
      );
      process.exit(2);
    }
    throw err;
  }

  // Replace rather than merge: `docs/wiki/` is the whole truth, so a page deleted
  // there must disappear from the wiki too. Anything else lets a stale page linger
  // with nothing in review pointing at it.
  for (const f of fs.readdirSync(work)) {
    if (f !== '.git') fs.rmSync(path.join(work, f), { recursive: true, force: true });
  }
  for (const f of pages) fs.copyFileSync(path.join(SOURCE, f), path.join(work, f));

  git(['add', '-A'], work);
  const diff = git(['status', '--porcelain'], work).trim();
  if (!diff) {
    console.log('Wiki already matches docs/wiki/ — nothing to publish.');
    process.exit(0);
  }

  console.log(`${pages.length} pages, changes:\n${diff}`);
  if (DRY) {
    console.log('\n--dry-run: nothing pushed.');
    process.exit(0);
  }

  const rev = git(['rev-parse', '--short', 'HEAD'], path.join(import.meta.dirname, '..')).trim();
  git(['commit', '-m', `Mirror docs/wiki/ from ${rev}`], work);
  // The default branch of a wiki repo is `master`, not `main` — GitHub has never
  // renamed it, so pushing `main` here creates an orphan branch nothing renders.
  git(['push', 'origin', 'HEAD:master'], work);
  console.log(`Published ${pages.length} pages to the wiki.`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
