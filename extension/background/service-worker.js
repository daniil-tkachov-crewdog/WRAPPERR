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

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'WRAPPERR_SEND') {
    const { ai, message, requestId } = msg;

    sendToAI(ai, message, requestId)
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
