# Konshu X Viewer

A Firefox extension that adds a line of context under each username in the X
(Twitter) feed, and keeps your Topic snoozes from expiring.

Under every username it shows:

- **Follower count** — green badge, person icon
- **Account age** — light-purple badge, calendar icon (e.g. `9.5y`, `8mo`, `12d`; hover for the exact join month)
- **Account based in** — caution-yellow badge, pin icon; verified accounts only. This is the country from X's *About this account* panel (the `/about` page), not the self-reported bio location.

It also **auto-renews X's Topic snoozes**, which normally expire every ~24 hours, so a set of snoozed topics stays snoozed without you re-doing it.

---

## What data this uses, and where it comes from

This extension does not scrape hidden data or bypass any access control. Every
value it displays is information X already sends to your browser and already
shows in its own UI:

- **Follower count, account age, verified flag** ride along in the timeline
  responses X fetches to render the feed. The extension reads those responses
  as they arrive and reads no extra requests to get them.
- **"Account based in"** is the exact field X renders in the *About this
  account* panel on any profile. The extension requests it the same way that
  panel does — using your existing logged-in session — only when a verified
  account appears in your feed, throttled, and cached so each account is
  fetched at most once a month.

In other words, the extension **adjusts how already-public, already-delivered
information is presented** — surfacing it inline instead of requiring a click
into a menu. It stores nothing about anyone on any server; all state lives in
your own browser.

## A note on X's Terms (read before sharing/installing)

X's Terms of Service restrict automated interaction with the service and use of
undocumented internal endpoints. Two features here touch that surface area: the
"Account based in" lookup calls an internal GraphQL endpoint (the same one X's
own UI calls), and snooze auto-renew replays a request you triggered. The data
involved is public and user-facing, and the extension is deliberately
conservative (throttled, cached, session-scoped, no background scraping) — but
using it is still your decision to make with full information. This project is
published so you can read exactly what it does and choose for yourself. It is
provided as-is, with no warranty, under the MIT License.

## Privacy

- No analytics, no telemetry, no external servers. Nothing leaves your browser
  except requests to X's own API, made with your own session.
- All persistence uses the extension's isolated `storage.local` — the based-in
  cache, the snooze state, and the queryId. Nothing is written into x.com's own
  page storage.
- Captured session auth headers live only in the page-context module's memory,
  are never persisted, and are never exposed on any global the page can reach.

---

## Install

### Temporary (development)

1. Open `about:debugging#/runtime/this-firefox`
2. **Load Temporary Add-on…** → select `manifest.json`
3. Open or reload x.com

Temporary add-ons unload when Firefox closes.

### Permanent

- **Developer Edition / Nightly:** set `xpinstall.signatures.required` to
  `false` in `about:config`, zip the folder contents (files at the zip root),
  rename to `.xpi`, and open it with Firefox.

---

## How it works

The extension has two contexts:

- **`content.js`** (extension sandbox) owns all persistence, decorates the DOM,
  and runs the snooze scheduler.
- **`interceptor.js`** (page context, injected once) observes the network
  traffic X's own frontend produces. It communicates with the content script
  only through `CustomEvent`s that carry non-sensitive data.

### Follower / age / verified badges
A `MutationObserver` watches the feed for `div[data-testid="User-Name"]` rows.
The interceptor harvests the public user fields from timeline responses and
forwards them; the content script renders a badge line under each row.

### "Account based in"
Not present in timeline data. For each verified account seen, the interceptor
issues one `AboutAccountQuery` request through a throttle (≤ ~1 per 1.2s, with a
60s backoff on HTTP 429), reusing the session headers observed on X's own
traffic. Results are cached in `storage.local` for 30 days (7 days for accounts
with no country available), so an account is fetched at most once and then
resolves instantly. The `AboutAccountQuery` operation id is sniffed from live
traffic and persisted, so the extension self-heals if X rotates it.

### Snooze auto-renew (capture & replay)
The extension has no model of X's topics and never reads the Snooze panel. When
*you* click **Snooze N topics**, X's frontend sends a request whose body already
encodes your selections. The interceptor captures that request as an opaque blob
(URL, method, body — no auth material). The scheduler then replays that
identical blob with fresh session headers:

- **On each visit:** if the last successful renewal was > 6h ago, it renews ~15s
  after page load, so every session starts inside a fresh 24h window.
- **Backstop:** a 10-minute tick renews once > 20h have passed, covering tabs
  left open for days.

Failures are detected honestly (HTTP status *and* GraphQL `errors` arrays in
200 responses). After three consecutive failures the capture is marked stale,
replays stop, and the toolbar popup asks you to snooze once to re-capture.
Because the blob is fixed, changing your topics means snoozing again on X; the
newest capture replaces the old one.

The toolbar popup exposes an on/off toggle and status (captured / last renewed /
next renewal / stale).

---

## Files

| File | Context | Purpose |
|---|---|---|
| `manifest.json` | — | MV3 manifest, Firefox settings, `storage` permission |
| `content.js` | extension sandbox | Persistence, DOM decoration, snooze scheduler |
| `interceptor.js` | page | Network observation, based-in lookups, snooze replay |
| `popup.html` / `popup.js` | extension | Toolbar UI (toggle + status) |
| `styles.css` | page | Badge styling |
| `LICENSE` | — | MIT |

## Maintenance notes

- DOM hook: `div[data-testid="User-Name"]`. Data shapes handled: current
  GraphQL (`core` + `legacy` + `is_blue_verified` / `verification.verified`)
  and the older flat schema. If X changes a response shape, `harvest()` in
  `interceptor.js` is the place to update.
- Reset the based-in cache from the popup context or by clearing the
  extension's storage; it is no longer stored in x.com page storage.

## Support

support@konshu.tv
