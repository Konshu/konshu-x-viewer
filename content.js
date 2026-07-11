/**
 * content.js — Konshu X Viewer (content-script sandbox)
 *
 * Responsibilities:
 *   1. Inject interceptor.js into the page context.
 *   2. Maintain the profile cache harvested from X's own feed responses and
 *      decorate each username row with follower count, account age, and
 *      (for verified accounts) the "Account based in" country.
 *   3. Persist the based-in cache and the AboutAccountQuery id in extension
 *      storage — never in the page's own origin storage.
 *   4. Drive snooze auto-renew: persist the request the user's click produced
 *      and replay it so topic snoozes do not lapse between sessions.
 *
 * All persistent state lives in `browser.storage.local`, isolated from x.com.
 */
(() => {
  'use strict';

  const ext = (typeof browser !== 'undefined' ? browser : chrome);
  const storage = ext.storage.local;

  // Event channel (kept in sync with interceptor.js).
  const EVT = {
    ready: 'kxv:ready',
    users: 'kxv:users',
    aboutReq: 'kxv:about-req',
    aboutRes: 'kxv:about-res',
    queryId: 'kxv:queryid',
    config: 'kxv:config',
    snoozeCaptured: 'kxv:snooze-captured',
    snoozeReplay: 'kxv:snooze-replay',
    snoozeReplayed: 'kxv:snooze-replayed',
  };

  const STORAGE = {
    basedIn: 'kxvBasedIn',      // { handle: { country, t } }
    queryId: 'kxvAboutQueryId', // string
    snooze: 'kxvSnooze',        // scheduler state
  };

  const LINE_CLASS = 'kxv-line';
  const PROCESSED_ATTR = 'data-kxv-done';

  const BASED_IN_TTL_MS = 30 * 24 * 60 * 60 * 1000;      // found: 30 days
  const BASED_IN_EMPTY_TTL_MS = 7 * 24 * 60 * 60 * 1000; // "none": 7 days

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];

  // In-memory state.
  const userCache = new Map();      // handle -> { c, v, j }
  const basedInCache = new Map();   // handle -> { country, t }
  const pendingLines = new Map();   // handle -> Set<HTMLElement>
  const requested = new Set();      // handles queried this session

  // =========================================================================
  // Persistence
  // =========================================================================
  async function loadPersistentState() {
    let data = {};
    try {
      data = await storage.get([STORAGE.basedIn, STORAGE.queryId]);
    } catch { /* first run or storage unavailable */ }

    const stored = data[STORAGE.basedIn];
    if (stored && typeof stored === 'object') {
      const now = Date.now();
      for (const handle in stored) {
        const entry = stored[handle];
        if (!entry) continue;
        const ttl = entry.country ? BASED_IN_TTL_MS : BASED_IN_EMPTY_TTL_MS;
        if (now - entry.t <= ttl) basedInCache.set(handle, entry);
      }
    }
    return typeof data[STORAGE.queryId] === 'string' ? data[STORAGE.queryId] : null;
  }

  // Debounced write-through so heavy scrolling doesn't hammer storage.
  let flushTimer = null;
  function scheduleBasedInFlush() {
    if (flushTimer !== null) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const obj = {};
      for (const [handle, entry] of basedInCache) obj[handle] = entry;
      storage.set({ [STORAGE.basedIn]: obj }).catch(() => {});
    }, 2000);
  }

  function getCachedBasedIn(handle) {
    const entry = basedInCache.get(handle);
    if (!entry) return null;
    const ttl = entry.country ? BASED_IN_TTL_MS : BASED_IN_EMPTY_TTL_MS;
    if (Date.now() - entry.t > ttl) {
      basedInCache.delete(handle);
      return null;
    }
    return entry;
  }

  // =========================================================================
  // Interceptor injection
  // =========================================================================
  function injectInterceptor(aboutQueryId) {
    const script = document.createElement('script');
    script.src = ext.runtime.getURL('interceptor.js');
    script.dataset.kxvConfig = JSON.stringify({ aboutQueryId: aboutQueryId || null });
    script.onload = () => script.remove();
    (document.head || document.documentElement).appendChild(script);
  }

  // Persisted config the interceptor may want; set once storage resolves.
  let loadedQueryId = null;

  function sendConfig() {
    document.dispatchEvent(
      new CustomEvent(EVT.config, { detail: JSON.stringify({ aboutQueryId: loadedQueryId }) })
    );
  }

  // If the interceptor finished loading after we sent config, it re-requests
  // via the ready event and we answer again.
  document.addEventListener(EVT.ready, sendConfig);

  // Persist a newly sniffed AboutAccountQuery id.
  document.addEventListener(EVT.queryId, (event) => {
    let cfg;
    try { cfg = JSON.parse(event.detail); } catch { return; }
    if (cfg && typeof cfg.aboutQueryId === 'string') {
      loadedQueryId = cfg.aboutQueryId;
      storage.set({ [STORAGE.queryId]: cfg.aboutQueryId }).catch(() => {});
    }
  });

  // =========================================================================
  // Profile data from the feed
  // =========================================================================
  document.addEventListener(EVT.users, (event) => {
    let users;
    try { users = JSON.parse(event.detail); } catch { return; }

    let changed = false;
    for (const handle in users) {
      const incoming = users[handle];
      if (!incoming || typeof incoming.c !== 'number') continue;
      const existing = userCache.get(handle);
      if (!existing || existing.c !== incoming.c || existing.v !== incoming.v || existing.j !== incoming.j) {
        // Preserve a previously seen join date if a later payload omits it.
        if (existing && existing.j && !incoming.j) incoming.j = existing.j;
        userCache.set(handle, incoming);
        changed = true;
      }
    }
    if (changed) scheduleSweep();
  });

  document.addEventListener(EVT.aboutRes, (event) => {
    let result;
    try { result = JSON.parse(event.detail); } catch { return; }
    const { handle, country, ok } = result;
    if (typeof handle !== 'string') return;

    if (ok) {
      basedInCache.set(handle, { country: country || '', t: Date.now() });
      scheduleBasedInFlush();
    } else {
      // Transient failure (rate limit / no auth yet): allow a later retry.
      requested.delete(handle);
    }

    if (country) {
      const lines = pendingLines.get(handle);
      if (lines) {
        for (const line of lines) {
          if (line.isConnected) line.appendChild(buildLocationBadge(country));
        }
      }
    }
    pendingLines.delete(handle);
  });

  function requestBasedIn(handle) {
    if (requested.has(handle)) return;
    requested.add(handle);
    document.dispatchEvent(
      new CustomEvent(EVT.aboutReq, { detail: JSON.stringify({ handle }) })
    );
  }

  // =========================================================================
  // Formatting
  // =========================================================================
  function formatCount(n) {
    if (n < 1000) return String(n);
    if (n < 10000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
    if (n < 1000000) return Math.round(n / 1000) + 'K';
    if (n < 10000000) return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
    return Math.round(n / 1000000) + 'M';
  }

  function formatAccountAge(createdAtString) {
    const created = new Date(createdAtString);
    if (isNaN(created.getTime())) return null;
    const ageMs = Date.now() - created.getTime();
    if (ageMs < 0) return null;
    const days = ageMs / 86400000;
    if (days < 30) return Math.max(1, Math.floor(days)) + 'd';
    if (days < 365) return Math.floor(days / 30.44) + 'mo';
    const years = days / 365.25;
    return years < 10 ? years.toFixed(1).replace(/\.0$/, '') + 'y' : Math.floor(years) + 'y';
  }

  // =========================================================================
  // DOM decoration
  // =========================================================================
  function extractHandle(nameBlock) {
    const links = nameBlock.querySelectorAll('a[href^="/"]');
    for (const link of links) {
      const text = (link.textContent || '').trim();
      if (text.startsWith('@')) return text.slice(1).toLowerCase();
    }
    for (const link of links) {
      const match = link.getAttribute('href').match(/^\/([A-Za-z0-9_]{1,15})$/);
      if (match) return match[1].toLowerCase();
    }
    return null;
  }

  function buildBadge(className, text, title) {
    const badge = document.createElement('span');
    badge.className = 'kxv-badge ' + className;
    badge.textContent = text;
    if (title) badge.title = title;
    return badge;
  }

  function buildLocationBadge(country) {
    return buildBadge('kxv-location', country, 'Account based in ' + country);
  }

  function buildLine(handle, user) {
    const line = document.createElement('div');
    line.className = LINE_CLASS;

    line.appendChild(
      buildBadge('kxv-followers', formatCount(user.c), user.c.toLocaleString() + ' followers')
    );

    if (user.j) {
      const age = formatAccountAge(user.j);
      if (age) {
        const joined = new Date(user.j);
        line.appendChild(
          buildBadge('kxv-age', age, 'Joined ' + MONTHS[joined.getMonth()] + ' ' + joined.getFullYear())
        );
      }
    }

    // "Account based in" — verified accounts only, one API lookup each.
    if (user.v) {
      const cached = getCachedBasedIn(handle);
      if (cached) {
        if (cached.country) line.appendChild(buildLocationBadge(cached.country));
      } else {
        if (!pendingLines.has(handle)) pendingLines.set(handle, new Set());
        pendingLines.get(handle).add(line);
        requestBasedIn(handle);
      }
    }

    return line;
  }

  function decorate(nameBlock) {
    if (nameBlock.getAttribute(PROCESSED_ATTR) === '1') return;

    const handle = extractHandle(nameBlock);
    if (!handle) {
      nameBlock.setAttribute(PROCESSED_ATTR, '1');
      return;
    }

    const user = userCache.get(handle);
    if (!user) return; // harvested data not in yet; a later sweep will retry

    nameBlock.insertAdjacentElement('afterend', buildLine(handle, user));
    nameBlock.setAttribute(PROCESSED_ATTR, '1');
  }

  function sweep() {
    const blocks = document.querySelectorAll(
      'div[data-testid="User-Name"]:not([' + PROCESSED_ATTR + '])'
    );
    for (const block of blocks) decorate(block);
  }

  let sweepTimer = null;
  function scheduleSweep() {
    if (sweepTimer !== null) return;
    sweepTimer = setTimeout(() => {
      sweepTimer = null;
      sweep();
    }, 150);
  }

  // =========================================================================
  // Snooze Topics auto-renew
  // =========================================================================
  const SnoozeRenew = (() => {
    const RENEW_INTERVAL_MS = 20 * 60 * 60 * 1000; // 20h — inside X's 24h expiry
    const VISIT_THRESHOLD_MS = 6 * 60 * 60 * 1000; // renew-on-visit if older
    const CHECK_EVERY_MS = 10 * 60 * 1000;         // backstop tick
    const BATCH_WINDOW_MS = 30 * 1000;             // captures within 30s = one batch
    const REPLAY_LOCK_MS = 5 * 60 * 1000;          // de-dupe across tabs
    const MAX_FAILURES = 3;                        // then mark stale

    const DEFAULT_STATE = {
      enabled: true,
      batch: [],
      capturedAt: 0,
      lastRenewed: 0,
      replayStartedAt: 0,
      failCount: 0,
      stale: false,
    };

    async function getState() {
      let data = {};
      try { data = await storage.get(STORAGE.snooze); } catch { /* ignore */ }
      return Object.assign({}, DEFAULT_STATE, data[STORAGE.snooze] || {});
    }

    function setState(state) {
      return storage.set({ [STORAGE.snooze]: state }).catch(() => {});
    }

    // Record the request the user's own "Snooze" click produced.
    document.addEventListener(EVT.snoozeCaptured, async (event) => {
      let req;
      try { req = JSON.parse(event.detail); } catch { return; }
      if (!req || typeof req.url !== 'string') return;

      const state = await getState();
      const now = Date.now();

      // Requests fired together form one batch; a later press replaces it.
      if (now - state.capturedAt > BATCH_WINDOW_MS) state.batch = [];
      state.batch.push({ url: req.url, method: req.method, body: req.body });
      state.capturedAt = now;
      state.lastRenewed = now; // manual snooze restarts the clock
      state.failCount = 0;
      state.stale = false;
      await setState(state);
    });

    document.addEventListener(EVT.snoozeReplayed, async (event) => {
      let result;
      try { result = JSON.parse(event.detail); } catch { return; }

      const state = await getState();
      state.replayStartedAt = 0;
      if (result && result.ok) {
        state.lastRenewed = Date.now();
        state.failCount = 0;
        state.stale = false;
      } else if (++state.failCount >= MAX_FAILURES) {
        // Captured request likely no longer valid (endpoint/id rotation).
        // Stop retrying; the popup prompts the user to re-snooze once.
        state.stale = true;
      }
      await setState(state);
    });

    async function tick(threshold) {
      const state = await getState();
      if (!state.enabled || state.stale || state.batch.length === 0) return;

      const now = Date.now();
      if (now - state.lastRenewed < threshold) return;
      if (now - state.replayStartedAt < REPLAY_LOCK_MS) return; // another tab/attempt

      state.replayStartedAt = now;
      await setState(state);

      document.dispatchEvent(
        new CustomEvent(EVT.snoozeReplay, { detail: JSON.stringify(state.batch) })
      );
    }

    function start() {
      setInterval(() => tick(RENEW_INTERVAL_MS), CHECK_EVERY_MS); // long-lived tabs
      setTimeout(() => tick(VISIT_THRESHOLD_MS), 15 * 1000);      // renew on visit
    }

    return { start };
  })();

  // =========================================================================
  // Boot
  // =========================================================================
  function startObserver() {
    new MutationObserver(scheduleSweep).observe(document.body, {
      childList: true,
      subtree: true,
    });
    scheduleSweep();
  }

  // Inject the interceptor immediately so its network hooks are in place
  // before X's own scripts issue their first API calls. The persisted
  // AboutAccountQuery id is loaded asynchronously and handed over once ready;
  // until then the interceptor uses its built-in default.
  injectInterceptor(null);

  (async () => {
    loadedQueryId = await loadPersistentState();
    if (loadedQueryId) sendConfig();

    if (document.body) startObserver();
    else document.addEventListener('DOMContentLoaded', startObserver, { once: true });

    SnoozeRenew.start();
  })();
})();
