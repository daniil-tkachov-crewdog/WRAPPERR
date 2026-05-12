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
  claude:     ['content-scripts/claude.js'],
  grok:       ['content-scripts/grok.js'],
  perplexity: ['content-scripts/perplexity.js'],
  gemini:     ['content-scripts/gemini.js'],
  deepseek:   ['content-scripts/deepseek.js'],
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
const pendingRequests = {};

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await tabMapReady;
  let changed = false;
  for (const [ai, id] of Object.entries(tabMap)) {
    if (id === tabId) { delete tabMap[ai]; changed = true; }
  }
  if (changed) await persistTabMap();
});

// ensureTab: returns a healthy tab on the AI's site, reusing the tracked tab when possible.
// Three failure modes we have to handle, otherwise we either hang or open duplicate tabs:
//   1. Tab was closed -> chrome.tabs.get throws, we fall through to creating a new tab.
//   2. Tab was discarded by Chrome to save memory -> reload it instead of creating a new one.
//   3. User (or a redirect) navigated the tab away from the AI's origin -> navigate it back.
// Only check origin (URL host prefix), not the full URL, because each AI site uses many sub-paths.
async function ensureTab(ai) {
  await tabMapReady;
  const tabId = tabMap[ai];

  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab) {
        if (tab.discarded) {
          // Reload preserves the URL, so the in-progress conversation survives Chrome's memory saver.
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
  // Extra settle time for SPA hydration
  await sleep(2000);
  return tab.id;
}

function waitForTabLoad(tabId) {
  return new Promise((resolve) => {
    function listener(id, info) {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
    // Also check immediately in case already loaded
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

async function injectContentScript(tabId, ai) {
  try {
    // Inject the shared helper before the AI-specific script so its global
    // wrapperrWaitForResponse() is defined when the AI script runs. Files are loaded in array
    // order. Re-injecting on every send is safe — function declarations just get redefined.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/_wrapperr-shared.js', ...AI_SCRIPTS[ai]],
    });
  } catch {
    // Script may already be injected
  }
}

// sendToAI: orchestrates a single message round-trip.
//   1. Ensure the AI tab exists and is on the right origin.
//   2. Inject the shared helper + AI-specific content script.
//   3. Send WRAPPERR_INJECT_ONLY to type the message and click send. The content script returns
//      a baseline (count + text of the last assistant message before injection) so we can
//      distinguish the new response from any prior one.
//   4. Poll WRAPPERR_GET_STATE every POLL_MS. Each poll returns the current best-known text
//      (from the network capture buffer or DOM scrape). We track stability with our own timer
//      here in the SW context — never throttled by tab visibility, unlike timers inside the
//      AI tab itself.
//   5. Resolve when the text has been non-empty, distinct from baseline, and unchanged for
//      STABLE_MS. Hard timeout at HARD_MS.
async function sendToAI(ai, message, requestId) {
  try {
    const tabId = await ensureTab(ai);
    await injectContentScript(tabId, ai);

    let injectResp;
    try {
      injectResp = await chrome.tabs.sendMessage(tabId, {
        type: 'WRAPPERR_INJECT_ONLY',
        message,
        requestId,
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

// pollForResponse: SW-side stability check. The tab itself never runs timers for this — its
// content script just synchronously reads buffer + DOM on each GET_STATE. SW decides when the
// response has stabilized.
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
      // Transient error — retry next poll.
      await sleep(POLL_MS);
      continue;
    }

    const text = (resp?.text || '').trim();

    // Skip if it's the baseline itself (page hasn't rendered the new bubble yet).
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

// Listen for messages from content scripts (wrapperr-bridge.js or AI scripts)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'WRAPPERR_SEND') {
    const { ai, message, requestId } = msg;

    sendToAI(ai, message, requestId)
      .then((text) => {
        // Send response back to the Wrapperr tab via wrapperr-bridge
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, response: text });
        sendResponse({ ok: true });
      })
      .catch((err) => {
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, error: err.message });
        sendResponse({ ok: false, error: err.message });
      });

    return true; // async response
  }

  if (msg.type === 'WRAPPERR_GET_STATUS') {
    pingWrapperrTab()
      .then((ok) => sendResponse({ status: ok ? 'connected' : 'issue' }))
      .catch(() => sendResponse({ status: 'issue' }));
    return true; // async response
  }
});

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
