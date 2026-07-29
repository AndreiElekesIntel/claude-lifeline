'use strict';
/**
 * Owns the analytics report: when it is computed, and who waits for it.
 *
 * The shape of the problem is that a report is cheap to serve and occasionally
 * expensive to produce. So:
 *
 *   - The last report is kept in memory and returned immediately. The UI never
 *     waits on a scan it did not ask for.
 *   - Scans run in a worker thread (see analytics-worker.js) because a cold one
 *     takes seconds and would otherwise stall the tray.
 *   - Concurrent requests share one scan. Without this, opening the Analytics tab
 *     while a poll is already running would start a second full read of the same
 *     456MB of transcripts.
 *   - A result younger than MIN_AGE_MS is reused rather than recomputed, so
 *     switching tabs back and forth does not re-scan.
 *
 * Nothing here writes to Claude Code's directories. Transcripts are read-only
 * input, so analytics cannot disturb a session that is running right now.
 */

const path = require('path');
const { Worker } = require('worker_threads');

/** Reuse a report younger than this instead of scanning again. */
const MIN_AGE_MS = 20_000;

/** A scan that has not finished by now is treated as failed rather than hanging the UI. */
const TIMEOUT_MS = 120_000;

class AnalyticsService {
  constructor({ loadConfig }) {
    this.loadConfig = loadConfig;
    this.last = null;
    this.lastAt = 0;
    this.error = null;
    /** The rate overrides the cached report was computed with — see ratesKey(). */
    this.lastRatesKey = null;
    /** The in-flight scan, shared by every caller that arrives during it. */
    this.pending = null;
  }

  /** True when the user has switched analytics off entirely. */
  disabled() {
    const cfg = this.loadConfig();
    return !cfg.analytics || cfg.analytics.enabled === false;
  }

  /**
   * Identity of the current pricing overrides.
   *
   * Held so that editing a rate shows the new cost immediately. Without it the
   * in-memory report would keep serving prices the user just changed, for as long
   * as it stayed inside the freshness window.
   */
  ratesKey() {
    const cfg = this.loadConfig();
    return JSON.stringify((cfg.analytics && cfg.analytics.rates) || {});
  }

  /**
   * The current report, scanning only if there is nothing fresh enough.
   *
   * `force` is for the explicit Refresh button — the only case where the user has
   * asked to pay the scan cost.
   */
  async get({ force = false } = {}) {
    if (this.disabled()) {
      return { disabled: true, report: null, error: null, scanning: false };
    }
    const fresh =
      this.last && Date.now() - this.lastAt < MIN_AGE_MS && this.lastRatesKey === this.ratesKey();
    if (!force && fresh) return this.snapshot();
    try {
      await this.scan();
    } catch (err) {
      this.error = (err && err.message) || String(err);
    }
    return this.snapshot();
  }

  /** Whatever is already known, with no scan. Used by the state poll. */
  snapshot() {
    return {
      disabled: this.disabled(),
      report: this.last,
      error: this.error,
      generatedAt: this.lastAt || null,
      scanning: Boolean(this.pending),
    };
  }

  /** Run a scan, or join the one already running. */
  scan() {
    if (this.pending) return this.pending;

    const cfg = this.loadConfig();
    const rates = (cfg.analytics && cfg.analytics.rates) || null;
    // An empty override object and null mean the same thing to the cache key, and
    // sending `{}` would look like a rate change on every call.
    const pricingOverrides = rates && Object.keys(rates).length ? rates : null;
    const ratesKey = this.ratesKey();

    this.pending = new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(path.join(__dirname, 'analytics-worker.js'), {
        workerData: { now: Date.now(), pricingOverrides, sessionLimit: 60 },
      });

      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        fn(arg);
      };

      const timer = setTimeout(() => finish(reject, new Error('Analytics scan timed out.')), TIMEOUT_MS);

      worker.on('message', (msg) => {
        if (msg && msg.ok) {
          this.last = msg.report;
          this.lastAt = Date.now();
          this.lastRatesKey = ratesKey;
          this.error = null;
          finish(resolve, msg.report);
        } else {
          finish(reject, new Error((msg && msg.error) || 'Analytics scan failed.'));
        }
      });
      worker.on('error', (err) => finish(reject, err));
      worker.on('exit', (code) => {
        if (!settled && code !== 0) finish(reject, new Error(`Analytics worker exited with code ${code}.`));
      });
    }).finally(() => {
      this.pending = null;
    });

    return this.pending;
  }
}

module.exports = { AnalyticsService, MIN_AGE_MS };
