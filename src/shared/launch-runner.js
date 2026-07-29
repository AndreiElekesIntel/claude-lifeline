'use strict';
/**
 * Turns a launch spec written by launcher.js back into a running `claude`.
 *
 * This exists so that a session's arguments never appear on a command line. The
 * spec is JSON, and JSON has no shell semantics — see the long note at the top of
 * launcher.js for the several ways every command-line route corrupts (or executes)
 * a user's pre-prompt on Windows.
 *
 * Two properties of this file are load-bearing, and both were established by
 * measurement rather than assumption:
 *
 *   - **No shell, ever.** Not `shell: true` (Node concatenates rather than escapes
 *     — it warns about exactly this — and the prompt came back truncated at its
 *     first newline), and not `cmd /c` either, which truncates the same way. A
 *     preset's prompt is multi-line by construction, since skills are joined with
 *     blank lines, so any cmd in the chain silently loses everything after line one.
 *
 *   - **stdio is inherited.** The console the terminal window created is handed
 *     straight to `claude`, which is what makes the session interactive. Anything
 *     else gives Claude Code a pipe and no TTY.
 *
 * Avoiding a shell means CreateProcess has to be given a real executable, because
 * it cannot run the `claude.cmd` shim that `npm i -g` puts on PATH and it does not
 * apply PATHEXT. Hence resolveExecutable() below.
 *
 * It is dependency-free and requires nothing from the rest of Lifeline: it is
 * spawned by a shell that knows nothing about the app's module layout.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** Print to the window and stop. The user is looking at a terminal, so say why. */
function die(message) {
  process.stderr.write(`\nClaude Lifeline could not start this session.\n${message}\n\n`);
  process.exit(1);
}

/**
 * Find a real executable for a bare command name.
 *
 * Returns the input unchanged if it is already a path to something executable, and
 * null when nothing was found — the caller turns that into an explanation rather
 * than an ENOENT.
 *
 * The npm case is the interesting one: `npm i -g @anthropic-ai/claude-code` puts
 * `claude.cmd` on PATH, and the actual binary inside the package next to it. A
 * `.cmd` cannot be launched without a shell, so the package's `.exe` is what gets
 * used.
 */
function resolveExecutable(name) {
  // An explicit path: trust it, but only if it is really there.
  if (/[\\/]/.test(name)) {
    try {
      return fs.statSync(name).isFile() ? name : null;
    } catch {
      return null;
    }
  }

  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const candidates = [];

  // A real executable on PATH beats everything else.
  for (const dir of dirs) {
    for (const ext of ['.exe', '.com']) candidates.push(path.join(dir, name + ext));
  }
  // The binary behind an npm global shim.
  for (const dir of dirs) {
    candidates.push(path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', `${name}.exe`));
  }
  // Where the native installer puts it.
  candidates.push(path.join(os.homedir(), '.local', 'bin', `${name}.exe`));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const specPath = process.argv[2];
if (!specPath) die('No launch spec was passed to the runner.');

let spec;
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
} catch (err) {
  die(`The launch spec at ${specPath} could not be read: ${err.message}`);
}

if (!spec || typeof spec.file !== 'string' || !Array.isArray(spec.args)) {
  die(`The launch spec at ${specPath} is not in the expected shape.`);
}

const exe = resolveExecutable(spec.file);
if (!exe) {
  die(
    `Could not find the ${spec.file} program.\n` +
      `Is the Claude Code CLI installed? Try running \`${spec.file} --version\` in this window.\n` +
      'If it works there but not here, its folder may not be on the PATH that Lifeline sees.'
  );
}

const result = spawnSync(exe, spec.args, {
  cwd: spec.cwd || undefined,
  stdio: 'inherit',
  // Never true. See the note at the top of this file.
  shell: false,
});

if (result.error) die(result.error.message);

// Mirror the child's fate rather than always exiting 0: the window stays open, so
// the exit code is information the user can act on.
if (result.signal) process.exit(1);
process.exit(result.status === null ? 1 : result.status);
