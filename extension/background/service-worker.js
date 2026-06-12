// AI_URLS — canonical landing page per AI. Used both as the initial create-tab URL and as the
// substring check in ensureTab() (we reload the tab if it has drifted to a different host, e.g.
// the user clicked a link that took it off-site).
const AI_URLS = {
  chatgpt:    'https://chatgpt.com',
  claude:     'https://claude.ai',
  grok:       'https://grok.com',
  perplexity: 'https://www.perplexity.ai',
  gemini:     'https://gemini.google.com',
  deepseek:   'https://chat.deepseek.com',
};

// AI_SCRIPTS values are arrays so an AI can declare additional helper files (parser, capture
// rule, etc.) that must be injected before its main content script. Files are injected in the
// order listed; later files can rely on globals defined by earlier ones.
const AI_SCRIPTS = {
  chatgpt:    ['content-scripts/providers/chatgpt-parser.js', 'content-scripts/chatgpt.js'],
  claude:     ['content-scripts/providers/claude-parser.js', 'content-scripts/claude.js'],
  grok:       ['content-scripts/providers/grok-parser.js', 'content-scripts/grok.js'],
  perplexity: ['content-scripts/providers/perplexity-parser.js', 'content-scripts/perplexity.js'],
  gemini:     ['content-scripts/providers/gemini-parser.js', 'content-scripts/gemini.js'],
  deepseek:   ['content-scripts/providers/deepseek-parser.js', 'content-scripts/deepseek.js'],
};

// tabMap: { [ai]: tabId }
// CRITICAL: Chrome MV3 service workers terminate after ~30s of inactivity and lose all in-memory
// state on the next event. Without persistence the second message after an idle gap thinks no AI
// tab exists and opens a fresh one, breaking conversation continuity. We mirror tabMap to
// chrome.storage.session (in-memory, browser-session-scoped, fast) and reload it on SW startup.
// Every read awaits tabMapReady; every write calls persistTabMap().
let tabMap = {};
const tabMapReady = chrome.storage.session.get('tabMap').then((r) => {
  if (r && r.tabMap && typeof r.tabMap === 'object') tabMap = r.tabMap;
}).catch(() => {});

async function persistTabMap() {
  try { await chrome.storage.session.set({ tabMap }); } catch {}
}

// pendingRequests: { [requestId]: { resolve, reject, timeoutId } }
// Reserved for a future request-correlation feature; not actively used by sendToAI today —
// the await chain inside sendToAI awaits the response inline. Left in so a refactor to a
// long-running streaming pipeline doesn't need to reintroduce this dict.
const pendingRequests = {};

// Tab-removed cleanup: if the user closes one of the AI tabs, drop it from tabMap so the next
// send opens a fresh one instead of trying to reuse the dead id. Awaits tabMapReady so we never
// race the SW startup load.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await tabMapReady;
  let changed = false;
  for (const [ai, id] of Object.entries(tabMap)) {
    if (id === tabId) { delete tabMap[ai]; changed = true; }
  }
  if (changed) await persistTabMap();
});

// ensureTab: returns a healthy tab on the AI's site, reusing the tracked tab when possible.
// Three reuse paths handled here:
//   1. Tab still alive on the right host → return as is.
//   2. Tab discarded by Chrome memory pressure → reload + small settle delay.
//   3. Tab navigated elsewhere → force-back to AI_URLS[ai] + settle delay.
// All failure paths fall through to a fresh chrome.tabs.create(). The 2s sleep after navigation
// gives the content scripts time to attach + the AI site's React app time to mount.
async function ensureTab(ai) {
  await tabMapReady;
  const tabId = tabMap[ai];

  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        if (tab.discarded) {
          await chrome.tabs.reload(tabId);
          await waitForTabLoad(tabId);
          await sleep(2000);
          return tabId;
        }
        if (!tab.url || !tab.url.startsWith(AI_URLS[ai])) {
          await chrome.tabs.update(tabId, { url: AI_URLS[ai] });
          await waitForTabLoad(tabId);
          await sleep(2000);
          return tabId;
        }
        return tabId;
      }
    } catch {
      delete tabMap[ai];
      await persistTabMap();
    }
  }

  const tab = await chrome.tabs.create({ url: AI_URLS[ai], active: false });
  tabMap[ai] = tab.id;
  await persistTabMap();
  await waitForTabLoad(tab.id);
  await sleep(2000);
  return tab.id;
}

// waitForTabLoad: resolves when the given tab reaches status 'complete'. Handles the race
// where the tab is already complete before we attach the listener by checking status once up
// front. Never rejects — a tab that never completes will just hang here until the caller's
// outer timeout fires.
function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// injectContentScript: every AI gets shared helpers + the universal input module + its own
// script chain. _wrapperr-input.js sits before AI scripts so wrapperrInjectInput() is defined
// when each AI's injectMessage runs.
async function injectContentScript(tabId, ai) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'content-scripts/_wrapperr-shared.js',
        'content-scripts/_wrapperr-input.js',
        ...AI_SCRIPTS[ai],
      ],
    });
  } catch {
    // Script may already be injected
  }
}

// sendToAI: ensures the AI's tab is alive, injects scripts, then asks the content script to
// apply per-AI options (best-effort) and inject the prompt. `options` is optional and may be
// undefined — the content script then just submits with the site's current state.
async function sendToAI(ai, message, requestId, options) {
  try {
    const tabId = await ensureTab(ai);
    await injectContentScript(tabId, ai);

    let injectResp;
    try {
      injectResp = await chrome.tabs.sendMessage(tabId, {
        type: 'WRAPPERR_INJECT_ONLY',
        message,
        requestId,
        options,
      });
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('Receiving end does not exist') || msg.includes('No tab with id')) {
        delete tabMap[ai];
        await persistTabMap();
      }
      throw new Error(msg || 'Failed to communicate with AI tab');
    }

    if (!injectResp?.ok) {
      throw new Error(injectResp?.error || 'Inject failed');
    }

    const sentAt = Date.now();
    const baseline = injectResp.baseline || { count: 0, text: '' };
    return await pollForResponse(tabId, ai, sentAt, baseline);
  } catch (err) {
    throw new Error(err?.message || 'Failed to communicate with AI tab');
  }
}

// rereadFromAI: ensures the AI's tab and content script are alive, then asks the content script
// for the latest assistant message text via WRAPPERR_REREAD_LATEST. No injection, no polling —
// the content script returns whatever the network buffer or DOM currently holds for the last
// turn. Throws if the tab can't be reached. Used by the Compare carousel's per-slide refresh.
async function rereadFromAI(ai) {
  const tabId = await ensureTab(ai);
  await injectContentScript(tabId, ai);

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: 'WRAPPERR_REREAD_LATEST' });
  } catch (err) {
    const m = err?.message || '';
    if (m.includes('Receiving end does not exist') || m.includes('No tab with id')) {
      delete tabMap[ai];
      await persistTabMap();
    }
    throw new Error(m || 'Failed to communicate with AI tab');
  }

  const text = (resp?.text || '').trim();
  if (!text) throw new Error('No response found on tab');
  return text;
}

// pollForResponse: drives the wait-until-AI-finishes loop. Poll every 500ms, treat the answer
// as "done" once the visible text hasn't changed for STABLE_MS (1.5s) and is distinct from the
// baseline (so we don't return the user's own prompt or the prior assistant turn). HARD_MS
// (240s) is the absolute ceiling — exceeded → return whatever we have, even if empty.
// Baseline is supplied by the content script's pre-inject snapshot of the chat.
async function pollForResponse(tabId, ai, sentAt, baseline) {
  const POLL_MS = 500;
  const STABLE_MS = 1500;
  const HARD_MS = 240000;

  const start = Date.now();
  let lastText = '';
  let lastChangeAt = Date.now();

  while (Date.now() - start < HARD_MS) {
    let resp;
    try {
      resp = await chrome.tabs.sendMessage(tabId, {
        type: 'WRAPPERR_GET_STATE',
        sentAt,
        baselineCount: baseline.count,
        baselineText: baseline.text,
      });
    } catch (err) {
      const msg = err?.message || '';
      if (msg.includes('Receiving end does not exist') || msg.includes('No tab with id')) {
        delete tabMap[ai];
        await persistTabMap();
        throw new Error(msg);
      }
      await sleep(POLL_MS);
      continue;
    }

    const text = (resp?.text || '').trim();

    if (text === (baseline.text || '').trim() || text === '') {
      await sleep(POLL_MS);
      continue;
    }

    if (text !== lastText) {
      lastText = text;
      lastChangeAt = Date.now();
    } else if (Date.now() - lastChangeAt >= STABLE_MS) {
      return text;
    }

    await sleep(POLL_MS);
  }

  return lastText || 'No response received.';
}

// Central message router for the SW. Three message types: WRAPPERR_SEND (full send pipeline),
// WRAPPERR_REREAD (re-scrape only, Compare carousel), WRAPPERR_GET_STATUS (popup heartbeat).
// All three return true synchronously to keep the response channel open for the async result;
// dropping the return value would cause sendResponse to be ignored by Chrome.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'WRAPPERR_SEND') {
    // options is optional — per-AI feature toggles ({ feature, intelligence, style }). When
    // present it's threaded to the content script's applyOptions; when absent the content
    // script submits with the site's current state. Adding a new slot here is additive.
    const { ai, message, requestId, options } = msg;

    sendToAI(ai, message, requestId, options)
      .then((text) => {
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, response: text });
        sendResponse({ ok: true });
      })
      .catch((err) => {
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, error: err.message });
        sendResponse({ ok: false, error: err.message });
      });

    return true;
  }

  // WRAPPERR_REREAD: re-scrape the latest assistant message from an existing AI tab WITHOUT
  // injecting a new prompt. The Compare carousel uses this when the original capture finished
  // too early (e.g. only "Thinking…" or a partial reply made it through). We expect the tab to
  // already hold the full completed response in DOM / network buffer, so we just read it again.
  if (msg.type === 'WRAPPERR_REREAD') {
    const { ai, requestId } = msg;

    rereadFromAI(ai)
      .then((text) => {
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, response: text });
        sendResponse({ ok: true });
      })
      .catch((err) => {
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, error: err.message });
        sendResponse({ ok: false, error: err.message });
      });

    return true;
  }

  if (msg.type === 'WRAPPERR_GET_STATUS') {
    pingWrapperrTab()
      .then((ok) => sendResponse({ status: ok ? 'connected' : 'issue' }))
      .catch(() => sendResponse({ status: 'issue' }));
    return true;
  }
});

// pingWrapperrTab: round-trips a WRAPPERR_PING to any open Wrapperr web app tab. Used by the
// popup status dot. Falls back to false on any error (no tab, content script not loaded, etc.).
async function pingWrapperrTab() {
  const tabs = await chrome.tabs.query({});
  const target = tabs.find(
    (t) => t.url?.includes('onrender.com') || t.url?.includes('localhost:3000')
  );
  if (!target) return false;
  try {
    const res = await chrome.tabs.sendMessage(target.id, { type: 'WRAPPERR_PING' });
    return res?.pong === true;
  } catch {
    return false;
  }
}

// sendToWrapperrTab: fan-out to EVERY open Wrapperr web app tab. Multiple tabs is unusual but
// supported — the requestId in the message body ensures only the originating tab acts on it.
// Errors are swallowed per-tab so a single closed/unreachable tab doesn't break the others.
async function sendToWrapperrTab(data) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (
      tab.url?.includes('onrender.com') ||
      tab.url?.includes('localhost:3000')
    ) {
      chrome.tabs.sendMessage(tab.id, data).catch(() => {});
    }
  }
}
