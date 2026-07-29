'use strict';
/**
 * Geometry QA: catches the layout faults a functional test cannot see.
 *
 * The app's other specs assert that things are present and that clicking them
 * works, which is exactly the kind of green suite that ships a page where two
 * controls are touching. These tests measure instead: overlapping boxes,
 * text clipped by its container, elements past the right edge, and headings
 * sitting flush against the text below them.
 *
 * Every check runs on every tab in both themes, and at a narrow width as well
 * as a wide one, because a collision usually appears at one size only.
 */

const { test, expect } = require('@playwright/test');
const fx = require('./fixtures');

const TABS = ['dashboard', 'sessions', 'analytics', 'coverage', 'activity', 'settings', 'about'];

/** Widths worth checking: the design target, and the narrowest supported window. */
const WIDTHS = [
  { name: 'wide', width: 1400, height: 900 },
  { name: 'design', width: 1180, height: 800 },
  { name: 'narrow', width: 900, height: 720 },
];

let ctx = null;

test.afterEach(async () => {
  if (ctx) await fx.close(ctx);
  ctx = null;
});

/** Seed enough that every tab renders real content rather than an empty state. */
function seedAll(sandbox) {
  const now = Date.now();
  const min = 60_000;
  fx.writeSession(sandbox, {
    pid: process.pid,
    sessionId: 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60',
    cwd: 'C:/work/payments-api',
    name: 'refactor-billing-service',
    status: 'busy',
    startedAt: now - 142 * min,
    updatedAt: now - 12_000,
  });
  // A deliberately long name and path: truncation bugs only show up when
  // something is actually too long for its column.
  fx.writeSession(sandbox, {
    pid: process.ppid || process.pid,
    sessionId: 'b7e2d4a9-1c3f-4e82-9d5a-6b8c2f1e7a34',
    cwd: 'C:/work/an-extremely-long-repository-name-that-will-not-fit/packages/telemetry-dashboard',
    name: 'add-latency-charts-and-a-very-long-branch-name-for-testing-overflow',
    status: 'idle',
    startedAt: now - 38 * min,
    updatedAt: now - 4 * min,
  });
  fx.writeEvents(sandbox, [
    { at: now - 96 * min, kind: 'recovered', sessionId: 'a3f8c1d2', cwd: 'C:/work/payments-api', errorClass: 'overloaded', label: 'API overloaded', strategy: 'resume', attemptNumber: 1, waitedMs: 30_000, detail: 'Resumed after api overloaded (attempt 1).' },
    { at: now - 44 * min, kind: 'recovered', sessionId: 'b7e2d4a9', cwd: 'C:/work/telemetry-dashboard', errorClass: 'unknown', label: 'Connection lost', strategy: 'resume', attemptNumber: 2, waitedMs: 40_000, detail: 'Resumed after connection lost (attempt 2).' },
    { at: now - 26 * min, kind: 'notified', sessionId: 'a3f8c1d2', cwd: 'C:/work/payments-api', errorClass: 'billing_error', label: 'Billing problem', needsAttention: true, detail: 'Needs a billing change; not retried.' },
  ]);
  fx.writeTranscript(sandbox, { slug: 'payments-api', id: 'a3f8c1d2-4b5e-4a91-8c3d-7e2f1b9a4c60', title: 'Refactor the billing service', cwd: 'C:/work/payments-api', messages: 24 });
  fx.writeTranscript(sandbox, { slug: 'telemetry-dashboard', id: 'b7e2d4a9-1c3f-4e82-9d5a-6b8c2f1e7a34', title: 'Add latency charts', cwd: 'C:/work/telemetry-dashboard', model: 'claude-sonnet-5', messages: 12 });
  fx.writeClaudeStats(sandbox);
}

/**
 * Walk to a tab and wait for it to settle.
 *
 * Analytics is the one that needs waiting on: it scans transcripts on first
 * open, and measuring mid-scan reports the geometry of a skeleton.
 */
async function openTab(page, tab) {
  await page.click(`.nav-item[data-tab="${tab}"]`);
  await expect(page.locator(`.tab[data-tab="${tab}"]`)).toBeVisible();
  if (tab === 'analytics') {
    await expect(page.locator('#analyticsBodyRows tr').first()).toBeVisible({ timeout: 20_000 });
  }
  // Two frames: one for layout, one for any entry transition to finish.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

/**
 * Every visible element's box and text metrics, in one pass.
 *
 * Collected in the page rather than via per-locator Playwright calls because a
 * settings tab has ~400 elements and a round trip each would take minutes.
 */
async function measure(page) {
  return page.evaluate(() => {
    const tab = document.querySelector('.tab.active') || document.querySelector('.tab:not(.hidden)');
    if (!tab) return { items: [], tabBox: null };

    const items = [];
    for (const el of tab.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;

      // A short, stable description — enough to find the element again by hand.
      const id = el.id ? `#${el.id}` : '';
      const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
      items.push({
        tag: el.tagName.toLowerCase(),
        desc: `${el.tagName.toLowerCase()}${id}${cls}`,
        text: (el.textContent || '').trim().slice(0, 40),
        x: r.x, y: r.y, w: r.width, h: r.height,
        scrollW: el.scrollWidth, scrollH: el.scrollHeight,
        clientW: el.clientWidth, clientH: el.clientHeight,
        overflowX: cs.overflowX, overflowY: cs.overflowY,
        childCount: el.children.length,
        position: cs.position,
      });
    }
    const b = tab.getBoundingClientRect();
    return { items, tabBox: { x: b.x, y: b.y, w: b.width, h: b.height } };
  });
}

/* ===================== text is never cut off ===================== */

test('no visible text is clipped by its own container', async () => {
  const sandbox = fx.makeSandbox('clip');
  seedAll(sandbox);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  const problems = [];

  for (const vp of WIDTHS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const tab of TABS) {
      await openTab(page, tab);
      const { items } = await measure(page);

      for (const it of items) {
        // Only leaf-ish text nodes: a scrolling container legitimately holds
        // more than it shows, and a wrapper's scrollWidth reflects its children.
        if (it.childCount > 0 || !it.text) continue;
        if (it.overflowX !== 'visible' || it.overflowY !== 'visible') continue;

        // 1px of slack absorbs sub-pixel rounding, which is not a bug.
        if (it.scrollW > it.clientW + 1) {
          problems.push(`${vp.name}/${tab}: ${it.desc} text overflows horizontally by ${Math.round(it.scrollW - it.clientW)}px — "${it.text}"`);
        }
        if (it.scrollH > it.clientH + 1) {
          problems.push(`${vp.name}/${tab}: ${it.desc} text overflows vertically by ${Math.round(it.scrollH - it.clientH)}px — "${it.text}"`);
        }
      }
    }
  }

  expect(problems.join('\n')).toBe('');
});

/* ================= nothing escapes the content area ================= */

test('nothing renders outside the content area', async () => {
  const sandbox = fx.makeSandbox('bounds');
  seedAll(sandbox);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  const problems = [];

  for (const vp of WIDTHS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const tab of TABS) {
      await openTab(page, tab);
      const { items, tabBox } = await measure(page);

      for (const it of items) {
        // Absolutely positioned decoration (the About hero's accent wash) is
        // meant to bleed, and is clipped by its own overflow:hidden parent.
        if (it.position === 'absolute' || it.position === 'fixed') continue;
        const right = it.x + it.w;
        if (right > tabBox.x + tabBox.w + 1) {
          problems.push(`${vp.name}/${tab}: ${it.desc} extends ${Math.round(right - tabBox.x - tabBox.w)}px past the right edge — "${it.text}"`);
        }
        if (it.x < tabBox.x - 1) {
          problems.push(`${vp.name}/${tab}: ${it.desc} starts ${Math.round(tabBox.x - it.x)}px left of the content area — "${it.text}"`);
        }
      }
    }
  }

  expect(problems.join('\n')).toBe('');
});

/* ================== siblings do not collide ================== */

/**
 * Adjacent siblings in a vertical stack must not overlap or touch.
 *
 * This is the check that catches "things are touching each other": two boxes
 * that share an edge look like one broken control, and no functional assertion
 * notices.
 */
test('stacked siblings keep a real gap and never overlap', async () => {
  const sandbox = fx.makeSandbox('collide');
  seedAll(sandbox);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  const problems = [];

  for (const vp of WIDTHS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const tab of TABS) {
      await openTab(page, tab);

      const found = await page.evaluate(() => {
        const out = [];
        const root = document.querySelector('.tab.active') || document.querySelector('.tab:not(.hidden)');
        if (!root) return out;

        const visible = (el) => {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
          if (cs.position === 'absolute' || cs.position === 'fixed') return false;
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        };
        const label = (el) => {
          const id = el.id ? `#${el.id}` : '';
          const cls = typeof el.className === 'string' && el.className ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
          return `${el.tagName.toLowerCase()}${id}${cls}`;
        };

        for (const parent of [root, ...root.querySelectorAll('*')]) {
          const cs = getComputedStyle(parent);
          // Only vertical stacks. A grid or a row wraps and reflows, and
          // "overlap" there means something different.
          const stacked = cs.display === 'block' || (cs.display === 'flex' && cs.flexDirection === 'column');
          if (!stacked) continue;

          const kids = Array.from(parent.children).filter(visible);
          for (let i = 0; i < kids.length - 1; i++) {
            const a = kids[i].getBoundingClientRect();
            const b = kids[i + 1].getBoundingClientRect();
            // Only compare boxes that share horizontal space; two columns side
            // by side in a block parent are not stacked.
            const sharesX = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2;
            if (!sharesX) continue;
            const gap = b.top - a.bottom;
            if (gap < -1) {
              out.push({ kind: 'overlap', px: Math.round(-gap), a: label(kids[i]), b: label(kids[i + 1]), text: (kids[i].textContent || '').trim().slice(0, 30) });
            }
          }
        }
        return out;
      });

      for (const f of found) {
        problems.push(`${vp.name}/${tab}: ${f.a} overlaps ${f.b} by ${f.px}px — "${f.text}"`);
      }
    }
  }

  expect(problems.join('\n')).toBe('');
});

/* ============ headings are not flush against their body text ============ */

test('a heading is never flush against the text below it', async () => {
  const sandbox = fx.makeSandbox('breathe');
  seedAll(sandbox);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.setViewportSize({ width: 1180, height: 800 });
  const problems = [];

  for (const tab of TABS) {
    await openTab(page, tab);

    const tight = await page.evaluate(() => {
      const out = [];
      const root = document.querySelector('.tab.active') || document.querySelector('.tab:not(.hidden)');
      if (!root) return out;

      for (const h of root.querySelectorAll('h1, h2, h3')) {
        const cs = getComputedStyle(h);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const next = h.nextElementSibling;
        if (!next) continue;
        const ncs = getComputedStyle(next);
        if (ncs.display === 'none' || ncs.visibility === 'hidden') continue;
        if (ncs.position === 'absolute' || ncs.position === 'fixed') continue;

        const a = h.getBoundingClientRect();
        const b = next.getBoundingClientRect();
        if (a.width === 0 || b.width === 0) continue;
        const sharesX = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2;
        if (!sharesX) continue;

        const gap = b.top - a.bottom;
        // 2px is the floor for "deliberately tight but not touching". Below
        // that the descenders of the heading meet the body text.
        if (gap < 2) {
          out.push({
            heading: `${h.tagName.toLowerCase()}${h.id ? '#' + h.id : ''}`,
            text: (h.textContent || '').trim().slice(0, 30),
            next: next.tagName.toLowerCase() + (next.className ? '.' + String(next.className).trim().split(/\s+/)[0] : ''),
            gap: Math.round(gap),
          });
        }
      }
      return out;
    });

    for (const t of tight) {
      problems.push(`${tab}: ${t.heading} "${t.text}" sits ${t.gap}px from ${t.next}`);
    }
  }

  expect(problems.join('\n')).toBe('');
});

/* ================= interactive controls are usable ================= */

test('every control is big enough to hit and none are stacked on each other', async () => {
  const sandbox = fx.makeSandbox('targets');
  seedAll(sandbox);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.setViewportSize({ width: 1180, height: 800 });
  const problems = [];

  for (const tab of TABS) {
    await openTab(page, tab);

    const found = await page.evaluate(() => {
      const root = document.querySelector('.tab.active') || document.querySelector('.tab:not(.hidden)');
      if (!root) return { small: [], overlapping: [] };

      const controls = Array.from(root.querySelectorAll('button, select, input, a[href], [role="tab"]')).filter((el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) return false;
        // .link-btn is an inline link inside a sentence, not a standalone
        // control. Its hit area is its own text, and padding it out to a
        // button-sized box would break the line it sits in.
        if (el.classList.contains('link-btn')) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });

      const label = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/)[0] : ''}`;

      // 20px, not the 44px touch guideline: this is a mouse-driven desktop app,
      // and its checkbox-sized toggles are legitimately smaller than a finger.
      const small = controls
        .filter((el) => { const r = el.getBoundingClientRect(); return r.height < 20 || r.width < 20; })
        .map((el) => { const r = el.getBoundingClientRect(); return { desc: label(el), w: Math.round(r.width), h: Math.round(r.height) }; });

      // Two clickable things on the same pixels means one of them cannot be
      // clicked at all.
      const overlapping = [];
      for (let i = 0; i < controls.length; i++) {
        for (let j = i + 1; j < controls.length; j++) {
          if (controls[i].contains(controls[j]) || controls[j].contains(controls[i])) continue;
          const a = controls[i].getBoundingClientRect();
          const b = controls[j].getBoundingClientRect();
          const ox = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const oy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (ox > 2 && oy > 2) {
            overlapping.push({ a: label(controls[i]), b: label(controls[j]), ox: Math.round(ox), oy: Math.round(oy) });
          }
        }
      }
      return { small, overlapping };
    });

    for (const s of found.small) problems.push(`${tab}: ${s.desc} is only ${s.w}x${s.h}px`);
    for (const o of found.overlapping) problems.push(`${tab}: ${o.a} and ${o.b} overlap by ${o.ox}x${o.oy}px — one cannot be clicked`);
  }

  expect(problems.join('\n')).toBe('');
});

/* ============== every analytics range and view holds together ============== */

/**
 * The rest of this file only ever sees Analytics in its opening state: the "your
 * work" view at a week. That leaves eleven combinations of range and view
 * unmeasured, and they render different content — a monthly axis instead of a
 * daily one, a per-model table instead of a session list. This sweeps all of
 * them for the same faults, at the width where a collision is most likely.
 */
test('no analytics range or view clips text, overflows, or collides', async () => {
  const sandbox = fx.makeSandbox('ranges');
  seedAll(sandbox);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.setViewportSize({ width: 1180, height: 800 });
  await openTab(page, 'analytics');

  const problems = [];
  const RANGES = ['week', 'month', 'quarter', 'half', 'year', 'all'];

  for (const view of ['work', 'usage']) {
    await page.click(`#analyticsViews .seg-btn[data-view="${view}"]`);
    for (const range of RANGES) {
      await page.click(`#analyticsRange .range-btn[data-range="${range}"]`);
      // Out-wait the glider's 280ms slide, or its box is caught mid-transform.
      await page.waitForTimeout(350);

      const where = `${view}/${range}`;
      const { items, tabBox } = await measure(page);

      for (const it of items) {
        if (it.childCount === 0 && it.text && it.overflowX === 'visible' && it.overflowY === 'visible') {
          if (it.scrollW > it.clientW + 1) problems.push(`${where}: ${it.desc} text overflows by ${Math.round(it.scrollW - it.clientW)}px — "${it.text}"`);
          if (it.scrollH > it.clientH + 1) problems.push(`${where}: ${it.desc} text overflows vertically by ${Math.round(it.scrollH - it.clientH)}px — "${it.text}"`);
        }
        if (it.position !== 'absolute' && it.position !== 'fixed' && it.x + it.w > tabBox.x + tabBox.w + 1) {
          problems.push(`${where}: ${it.desc} extends ${Math.round(it.x + it.w - tabBox.x - tabBox.w)}px past the right edge`);
        }
      }

      // The glider is absolutely positioned, so it is exempt from the checks
      // above — but it is the one element whose whole job is to be in the right
      // place, so it gets measured directly.
      const glider = await page.evaluate(() => {
        const active = document.querySelector('#analyticsRange .range-btn.active');
        const g = document.querySelector('#rangeGlider');
        const host = document.querySelector('#analyticsRange');
        if (!active || !g || !host) return null;
        const a = active.getBoundingClientRect();
        const gr = g.getBoundingClientRect();
        const h = host.getBoundingClientRect();
        return {
          dx: Math.abs(a.x - gr.x),
          dw: Math.abs(a.width - gr.width),
          w: gr.width,
          escapes: gr.x < h.x - 1 || gr.right > h.right + 1,
        };
      });
      if (!glider) {
        problems.push(`${where}: no active range button or glider`);
      } else {
        if (glider.w < 1) problems.push(`${where}: the glider has no width — it never measured its target`);
        if (glider.dx > 2 || glider.dw > 2) problems.push(`${where}: the glider is ${Math.round(glider.dx)}px/${Math.round(glider.dw)}px off its button`);
        if (glider.escapes) problems.push(`${where}: the glider extends past the picker it sits in`);
      }
    }
  }

  expect(problems.join('\n')).toBe('');
});

/* ===================== light theme is not an afterthought ===================== */

test('the light theme has the same geometry as the dark one', async () => {
  const sandbox = fx.makeSandbox('themegeo');
  seedAll(sandbox);
  ctx = await fx.launch(sandbox);
  const { page } = ctx;

  await page.setViewportSize({ width: 1180, height: 800 });

  /** Content height per tab, which is the measure a colour change must not alter. */
  async function heights() {
    const out = {};
    for (const tab of TABS) {
      await openTab(page, tab);
      out[tab] = await page.evaluate(() => {
        const t = document.querySelector('.tab.active') || document.querySelector('.tab:not(.hidden)');
        return t ? Math.round(t.scrollHeight) : 0;
      });
    }
    return out;
  }

  // Read the starting theme rather than assuming dark. The default config is
  // `theme: 'system'`, so which one the app opens in depends on the Windows
  // setting of whatever machine is running the suite.
  const first = await page.getAttribute('html', 'data-theme');
  const second = first === 'dark' ? 'light' : 'dark';

  const dark = await heights();

  await page.click('#themeToggle');
  await expect(page.locator('html')).toHaveAttribute('data-theme', second);
  const light = await heights();

  // A theme is a palette. If switching it reflows the page, some rule is
  // changing box metrics rather than colour — a border width, usually.
  const drift = TABS.filter((t) => Math.abs(dark[t] - light[t]) > 2)
    .map((t) => `${t}: ${first} ${dark[t]}px vs ${second} ${light[t]}px`);
  expect(drift.join('\n')).toBe('');
});
