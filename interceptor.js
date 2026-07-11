/**
 * interceptor.js — Konshu X Viewer (page context)
 *
 * Runs in the page's JavaScript context (injected by content.js) so it can
 * observe the network traffic X's own frontend generates. It never issues
 * traffic of its own except:
 *   - "Account based in" lookups, throttled, using the same session the
 *     browser already holds; and
 *   - replays of a snooze request the user themselves triggered.
 *
 * Design constraints:
 *   - Nothing sensitive is ever placed on `window`. Captured auth headers and
 *     the native fetch reference live only in this module's closure. The page
 *     and other extensions cannot reach them.
 *   - Communication with the content script is via CustomEvents, which carry
 *     only non-sensitive data (public profile fields, opaque request blobs the
 *     user's own click produced). Auth material never crosses that boundary.
 *   - The page must never break: every hook is wrapped so a throw here can
 *     never propagate into X's code.
 */
(() => {
  'use strict';

  // Event channel (page <-> content). Kept in sync with content.js.
  const EVT = {
    ready: 'kxv:ready',              // page -> content: interceptor is listening
    users: 'kxv:users',              // page -> content: harvested profiles
    aboutReq: 'kxv:about-req',       // content -> page: look up based-in
    aboutRes: 'kxv:about-res',       // page -> content: based-in result
    queryId: 'kxv:queryid',          // page -> content: persist sniffed id
    config: 'kxv:config',            // content -> page: persisted config
    snoozeCaptured: 'kxv:snooze-captured', // page -> content: request recorded
    snoozeReplay: 'kxv:snooze-replay',     // content -> page: replay now
    snoozeReplayed: 'kxv:snooze-replayed', // page -> content: replay result
  };

  // ---- Closure-private state (never exposed) --------------------------------
  const nativeFetch = window.fetch.bind(window);
  /** Latest auth headers observed on X's own API calls. */
  let authHeaders = null;
  /** GraphQL operation id for AboutAccountQuery; refreshed from live traffic. */
  let aboutQueryId = null;

  // Reasonable default; the live id is sniffed from traffic and persisted by
  // the content script, so this only matters on the very first lookup ever.
  const DEFAULT_ABOUT_QUERY_ID = 'XRqGa7EeokUU5kppkh13EA';

  // Boot config passed by the content script on the injected <script> element.
  try {
    const raw = document.currentScript && document.currentScript.dataset
      ? document.currentScript.dataset.kxvConfig
      : null;
    if (raw) {
      const cfg = JSON.parse(raw);
      if (typeof cfg.aboutQueryId === 'string') aboutQueryId = cfg.aboutQueryId;
    }
  } catch { /* fall back to default */ }

  // Later config (e.g. queryId loaded asynchronously from storage).
  document.addEventListener(EVT.config, (event) => {
    let cfg;
    try { cfg = JSON.parse(event.detail); } catch { return; }
    if (cfg && typeof cfg.aboutQueryId === 'string' && !aboutQueryId) {
      aboutQueryId = cfg.aboutQueryId;
    }
  });

  // Announce readiness so the content script can (re)send config even if it
  // finished loading before this module registered the listener above.
  document.dispatchEvent(new CustomEvent(EVT.ready));

  // ---- Small helpers --------------------------------------------------------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function emit(name, payload) {
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(payload) }));
  }

  function isApiUrl(url) {
    return (
      typeof url === 'string' &&
      (url.includes('/i/api/') ||
        url.includes('/graphql/') ||
        url.includes('api.x.com') ||
        url.includes('api.twitter.com'))
    );
  }

  function urlOf(input) {
    if (typeof input === 'string') return input;
    if (input && typeof input.url === 'string') return input.url;
    return '';
  }

  function headersToObject(headers) {
    if (!headers) return null;
    const obj = {};
    if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      headers.forEach((value, key) => { obj[key] = value; });
    } else if (typeof headers === 'object') {
      for (const key in headers) obj[key] = headers[key];
    }
    return obj;
  }

  /** Retain the header set only if it actually carries session auth. */
  function maybeCaptureHeaders(headers) {
    const obj = headersToObject(headers);
    if (!obj) return;
    const hasAuth = Object.keys(obj).some((k) => k.toLowerCase() === 'authorization');
    if (hasAuth) authHeaders = obj;
  }

  async function waitForAuthHeaders(timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    while (!authHeaders && Date.now() < deadline) await sleep(200);
    return authHeaders;
  }

  function sniffAboutQueryId(url) {
    const match = /\/i\/api\/graphql\/([^/]+)\/AboutAccountQuery/.exec(url);
    if (match && match[1] && match[1] !== aboutQueryId) {
      aboutQueryId = match[1];
      emit(EVT.queryId, { aboutQueryId });
    }
  }

  function looksLikeSnooze(url, body) {
    if (typeof url !== 'string' || !url.includes('/i/api/')) return false;
    if (/snooze/i.test(url)) return true;
    return url.includes('/graphql/') && typeof body === 'string' && /snooze/i.test(body);
  }

  // ---- Profile harvesting ---------------------------------------------------
  // X's timeline responses embed a full user object per tweet. We read the
  // public fields we display (follower count, verified flag, join date) and
  // forward them; no extra request is made for any of this.
  function recordUser(out, screenName, followers, verified, createdAt) {
    if (!screenName || typeof followers !== 'number') return;
    const entry = out[screenName.toLowerCase()] || (out[screenName.toLowerCase()] = {});
    entry.c = followers;
    entry.v = !!verified;
    if (typeof createdAt === 'string' && createdAt) entry.j = createdAt;
  }

  function harvest(node, out, depth) {
    if (!node || typeof node !== 'object' || depth > 30) return;

    if (Array.isArray(node)) {
      for (const item of node) harvest(item, out, depth + 1);
      return;
    }

    const legacy = node.legacy;
    if (legacy && typeof legacy === 'object') {
      const screenName =
        (typeof legacy.screen_name === 'string' && legacy.screen_name) ||
        (node.core && typeof node.core.screen_name === 'string' && node.core.screen_name);
      const followers =
        typeof legacy.followers_count === 'number' ? legacy.followers_count
          : typeof legacy.normal_followers_count === 'number' ? legacy.normal_followers_count
            : null;
      if (screenName && followers !== null) {
        const verified =
          node.is_blue_verified === true ||
          legacy.verified === true ||
          (node.verification && node.verification.verified === true);
        const createdAt =
          (typeof legacy.created_at === 'string' && legacy.created_at) ||
          (node.core && typeof node.core.created_at === 'string' && node.core.created_at) ||
          '';
        recordUser(out, screenName, followers, verified, createdAt);
      }
    }

    // Flat (older REST) user shape.
    if (typeof node.screen_name === 'string' && typeof node.followers_count === 'number') {
      recordUser(
        out,
        node.screen_name,
        node.followers_count,
        node.is_blue_verified === true || node.verified === true,
        typeof node.created_at === 'string' ? node.created_at : ''
      );
    }

    for (const key in node) {
      const value = node[key];
      if (value && typeof value === 'object') harvest(value, out, depth + 1);
    }
  }

  function harvestResponseText(text) {
    if (!text || text.length < 2) return;
    let data;
    try { data = JSON.parse(text); } catch { return; }
    const users = {};
    harvest(data, users, 0);
    if (Object.keys(users).length > 0) emit(EVT.users, users);
  }

  // ---- Network hooks (single fetch patch + single XHR patch) ----------------
  // One observation point per transport keeps the control flow obvious and
  // avoids the fragility of stacking multiple wrappers.
  window.fetch = function (...args) {
    const request = args[0];
    const options = args[1] || {};
    const url = urlOf(request);

    try {
      if (isApiUrl(url)) {
        sniffAboutQueryId(url);
        maybeCaptureHeaders(options.headers);
        if (request && typeof request.headers === 'object') maybeCaptureHeaders(request.headers);
        const body = typeof options.body === 'string' ? options.body : null;
        if (looksLikeSnooze(url, body)) {
          emit(EVT.snoozeCaptured, {
            url,
            method: (options.method || 'POST').toUpperCase(),
            body,
          });
        }
      }
    } catch { /* observation must never break the request */ }

    const result = nativeFetch(...args);

    try {
      if (isApiUrl(url)) {
        result
          .then((response) => {
            response.clone().text().then(harvestResponseText).catch(() => {});
            return response;
          })
          .catch(() => {});
      }
    } catch { /* ignore */ }

    return result;
  };

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const nativeSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__kxvUrl = url;
    this.__kxvMethod = method;
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (header, value) {
    (this.__kxvHeaders || (this.__kxvHeaders = {}))[header] = value;
    return nativeSetHeader.call(this, header, value);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    try {
      if (isApiUrl(this.__kxvUrl)) {
        sniffAboutQueryId(this.__kxvUrl);
        if (this.__kxvHeaders) maybeCaptureHeaders(this.__kxvHeaders);
        const body = typeof args[0] === 'string' ? args[0] : null;
        if (looksLikeSnooze(this.__kxvUrl, body)) {
          emit(EVT.snoozeCaptured, {
            url: this.__kxvUrl,
            method: (this.__kxvMethod || 'POST').toUpperCase(),
            body,
          });
        }
        this.addEventListener('load', function () {
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              harvestResponseText(this.responseText);
            }
          } catch { /* ignore */ }
        });
      }
    } catch { /* ignore */ }
    return nativeSend.apply(this, args);
  };

  // ---- "Account based in" lookups (throttled queue) -------------------------
  const aboutQueue = [];
  const queued = new Set();
  let queueRunning = false;
  let backoffUntil = 0;

  const REQUEST_SPACING_MS = 1200;    // <= ~50 lookups/min
  const RATE_LIMIT_BACKOFF_MS = 60000;

  function currentOrigin() {
    return 'https://' + location.hostname.replace('twitter.com', 'x.com');
  }

  async function fetchBasedIn(handle) {
    const headers = await waitForAuthHeaders();
    if (!headers) return { ok: false, country: '' };

    const variables = encodeURIComponent(JSON.stringify({ screenName: handle }));
    const url =
      currentOrigin() +
      '/i/api/graphql/' +
      (aboutQueryId || DEFAULT_ABOUT_QUERY_ID) +
      '/AboutAccountQuery?variables=' +
      variables;

    try {
      const response = await nativeFetch(url, {
        method: 'GET',
        credentials: 'include',
        headers,
        referrer: location.href,
        referrerPolicy: 'origin-when-cross-origin',
      });

      if (response.status === 429) {
        backoffUntil = Date.now() + RATE_LIMIT_BACKOFF_MS;
        return { ok: false, country: '' };
      }

      const data = await response.json();
      const result =
        data && data.data &&
        data.data.user_result_by_screen_name &&
        data.data.user_result_by_screen_name.result;
      const country =
        result && result.about_profile && typeof result.about_profile.account_based_in === 'string'
          ? result.about_profile.account_based_in
          : '';
      // ok:true even when empty — a definitive "no country", which the content
      // script caches so the account is not looked up again.
      return { ok: true, country };
    } catch {
      return { ok: false, country: '' };
    }
  }

  async function drainQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      while (aboutQueue.length > 0) {
        const wait = backoffUntil - Date.now();
        if (wait > 0) await sleep(wait);

        const handle = aboutQueue.shift();
        queued.delete(handle);

        const { ok, country } = await fetchBasedIn(handle);
        emit(EVT.aboutRes, { handle, country, ok });

        await sleep(REQUEST_SPACING_MS);
      }
    } finally {
      queueRunning = false;
    }
  }

  document.addEventListener(EVT.aboutReq, (event) => {
    let payload;
    try { payload = JSON.parse(event.detail); } catch { return; }
    const handle = payload && payload.handle;
    if (typeof handle !== 'string' || !handle || queued.has(handle)) return;
    queued.add(handle);
    aboutQueue.push(handle);
    drainQueue();
  });

  // ---- Snooze replay --------------------------------------------------------
  // Replays the exact request(s) the user's own "Snooze" click produced, using
  // the current session headers. Auth stays in this closure throughout.
  document.addEventListener(EVT.snoozeReplay, async (event) => {
    let batch;
    try { batch = JSON.parse(event.detail); } catch { return; }
    if (!Array.isArray(batch) || batch.length === 0) return;

    const headers = await waitForAuthHeaders();
    if (!headers) {
      emit(EVT.snoozeReplayed, { ok: false });
      return;
    }

    let ok = true;
    for (const req of batch) {
      try {
        const response = await nativeFetch(req.url, {
          method: req.method || 'POST',
          credentials: 'include',
          headers,
          body: req.method === 'GET' ? undefined : req.body,
          referrer: location.href,
          referrerPolicy: 'origin-when-cross-origin',
        });
        if (!response.ok) {
          ok = false;
        } else {
          // GraphQL failures return HTTP 200 with an "errors" array — the only
          // failure signal observable from here.
          try {
            const parsed = await response.clone().json();
            if (parsed && Array.isArray(parsed.errors) && parsed.errors.length > 0) ok = false;
          } catch { /* non-JSON body: trust the HTTP status */ }
        }
      } catch {
        ok = false;
      }
      await sleep(500);
    }

    emit(EVT.snoozeReplayed, { ok });
  });
})();
