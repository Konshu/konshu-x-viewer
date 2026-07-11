'use strict';

const STORAGE_KEY = 'kxvSnooze';
const RENEW_INTERVAL_MS = 20 * 60 * 60 * 1000;
const ext = typeof browser !== 'undefined' ? browser : chrome;

const DEFAULT_STATE = {
  enabled: true,
  batch: [],
  capturedAt: 0,
  lastRenewed: 0,
  failCount: 0,
  stale: false,
};

function timeAgo(ts) {
  if (!ts) return 'never';
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  const hours = Math.floor(mins / 60);
  if (hours < 48) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

async function getState() {
  let data = {};
  try { data = await ext.storage.local.get(STORAGE_KEY); } catch { /* ignore */ }
  return Object.assign({}, DEFAULT_STATE, data[STORAGE_KEY] || {});
}

/**
 * Render status without innerHTML. `parts` is a list of nodes/strings; strings
 * become text nodes, so no markup is ever parsed from a string.
 */
function setStatus(...parts) {
  const el = document.getElementById('status');
  el.textContent = '';
  for (const part of parts) {
    el.appendChild(typeof part === 'string' ? document.createTextNode(part) : part);
  }
}

function span(className, text) {
  const s = document.createElement('span');
  if (className) s.className = className;
  s.textContent = text;
  return s;
}

function bold(text) {
  const b = document.createElement('b');
  b.textContent = text;
  return b;
}

function br() {
  return document.createElement('br');
}

function renderStale(state) {
  setStatus(
    span('warn', 'Captured snooze no longer works.'), br(),
    'X likely changed the endpoint since it was recorded. Open Snooze Topics ' +
      'on X and snooze once to re-capture — auto-renew resumes immediately.',
    br(), br(),
    'Last successful renewal: ', bold(timeAgo(state.lastRenewed))
  );
}

function renderEmpty() {
  setStatus(
    span('warn', 'No snooze captured yet.'), br(),
    'Open X\u2019s Snooze Topics panel, pick your topics, and click Snooze ' +
      'once. The extension records it and renews it automatically from then on.'
  );
}

function renderActive(state) {
  const next = state.lastRenewed + RENEW_INTERVAL_MS;
  const nextText =
    next <= Date.now()
      ? 'on the next check (within ~10 min of an open x.com tab)'
      : 'on your next visit to X (if 6h+ since last), or in ~' +
        Math.max(1, Math.round((next - Date.now()) / 3600000)) +
        'h if a tab stays open';

  setStatus(
    span('ok', 'Snooze captured.'), br(),
    'Captured: ', bold(timeAgo(state.capturedAt)), br(),
    'Last renewed: ', bold(timeAgo(state.lastRenewed)), br(),
    'Next renewal: ', bold(nextText), br(), br(),
    'To change topics, just snooze again on X — the newest selection replaces the old one.'
  );
}

async function render() {
  const state = await getState();
  document.getElementById('enabled').checked = !!state.enabled;

  if (state.stale) renderStale(state);
  else if (state.batch.length === 0) renderEmpty();
  else renderActive(state);
}

document.getElementById('enabled').addEventListener('change', async (e) => {
  const state = await getState();
  state.enabled = e.target.checked;
  try { await ext.storage.local.set({ [STORAGE_KEY]: state }); } catch { /* ignore */ }
  render();
});

render();
