'use strict';
/**
 * The watcher behind the tray icon.
 *
 * Recovery itself is done by the hook, in-process inside Claude Code — this
 * monitor never performs a rescue. It observes: tails the event log, polls
 * session state, and derives the status the tray shows. That separation is why
 * closing the app cannot stop recovery.
 */

const { EventEmitter } = require('events');
const fs = require('fs');

const { loadConfig } = require('../shared/config');
const eventlog = require('../shared/eventlog');
const ledger = require('../shared/ledger');
const sessions = require('../shared/sessions');
const { eventLogFile } = require('../shared/paths');

/** Tray states, in order of precedence when several apply. */
const STATUS = {
  PAUSED: 'paused',
  ERROR: 'error',
  ATTENTION: 'attention',
  RUNNING: 'running',
  WAITING: 'waiting',
};

class Monitor extends EventEmitter {
  constructor({ pollMs = 5_000 } = {}) {
    super();
    this.pollMs = pollMs;
    this.timer = null;
    this.watcher = null;
    this.state = {
      status: STATUS.WAITING,
      config: loadConfig(),
      sessions: [],
      summary: { total: 0, alive: 0, busy: 0, idle: 0, stalled: 0, dead: 0 },
      stats: { today: 0, lastHour: 0, total: 0, lastAttemptAt: null, sessions: 0 },
      events: [],
      attention: [],
      lastPollAt: null,
    };
  }

  start() {
    eventlog.rotate((this.state.config.advanced && this.state.config.advanced.eventLogLimit) || 2000);
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
    this.watchEventLog();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.watcher) this.watcher.close();
    this.timer = null;
    this.watcher = null;
  }

  /**
   * Watch the event log so a recovery surfaces immediately rather than on the
   * next poll — the moment a session is rescued is the one the user cares about.
   */
  watchEventLog() {
    try {
      const file = eventLogFile();
      if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');
      this.watcher = fs.watch(file, { persistent: false }, () => {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this.poll(), 250);
      });
    } catch {
      // Falls back to interval polling; not worth failing startup over.
    }
  }

  poll() {
    try {
      const config = loadConfig();
      const now = Date.now();
      const stalledAfter = (config.limits && config.limits.stalledAfterMs) || 900_000;
      const all = sessions.listSessions(now);
      const summary = sessions.summarise(all, stalledAfter);
      const events = eventlog.read(200);
      const stats = ledger.stats(now);

      // The ledger counts attempts for rate limiting; the event log is the
      // record of what actually happened. The dashboard must agree with the
      // timeline sitting next to it, so the displayed count comes from events —
      // otherwise a pruned or lost ledger would show "0 recovered" above a list
      // of visible recoveries.
      const recovered = events.filter((e) => e.kind === eventlog.KINDS.RECOVERED);
      stats.recoveredToday = recovered.filter((e) => now - e.at < 86_400_000).length;
      stats.lastRecoveryAt = recovered.length ? recovered[0].at : null;
      // The same reasoning applies to the all-time figure the About page shows.
      // `stats.total` is a count of ledger *attempts*, which the ledger prunes to
      // 48 hours — so on any machine older than that it reported 0 recoveries
      // above a timeline listing them. This is capped by the event log's own read
      // window, and named so rather than as a grand total.
      stats.recoveredLogged = recovered.length;

      // Anything a human needs to act on: non-retryable failures and hit caps.
      const attention = events
        .filter((e) => e.needsAttention && now - e.at < 6 * 3_600_000)
        .slice(0, 20);

      const state = {
        status: this.deriveStatus({ config, summary, attention, events, now }),
        config,
        sessions: all,
        summary,
        stats,
        events,
        attention,
        lastPollAt: now,
      };

      const changed = JSON.stringify(state) !== JSON.stringify(this.state);
      this.state = state;
      if (changed) this.emit('update', state);
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Which of the five states the tray shows.
   *
   * Ordered by urgency, not by recency: a paused Lifeline is the most important
   * thing to convey (nothing is protected), and an attention item outranks the
   * happy path because it will not resolve on its own.
   */
  deriveStatus({ config, summary, attention, events, now }) {
    if (!config.enabled) return STATUS.PAUSED;

    const recentError = events.find((e) => e.kind === eventlog.KINDS.ERROR && now - e.at < 300_000);
    if (recentError) return STATUS.ERROR;
    if (attention.length > 0) return STATUS.ATTENTION;
    if (summary.stalled > 0 && config.features.stalledSessionDetection) return STATUS.ATTENTION;
    if (summary.dead > 0 && config.features.deadSessionDetection) return STATUS.ATTENTION;

    // "Running" means there is live work to protect; otherwise we are watching.
    if (summary.busy > 0) return STATUS.RUNNING;
    return STATUS.WAITING;
  }

  /** One-line summary for the tray tooltip. */
  tooltip() {
    const s = this.state;
    if (!s.config.enabled) return 'Claude Lifeline — paused';
    const parts = [`${s.summary.alive} session${s.summary.alive === 1 ? '' : 's'}`];
    if (s.summary.busy) parts.push(`${s.summary.busy} working`);
    if (s.summary.stalled) parts.push(`${s.summary.stalled} stalled`);
    if (s.stats.today) parts.push(`${s.stats.today} recovered today`);
    return `Claude Lifeline — ${parts.join(', ')}`;
  }

  getState() {
    return this.state;
  }
}

module.exports = { Monitor, STATUS };
