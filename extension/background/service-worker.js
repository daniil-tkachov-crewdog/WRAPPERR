const AI_URLS = {
  chatgpt:    'https://chatgpt.com',
  claude:     'https://claude.ai',
  grok:       'https://grok.com',
  perplexity: 'https://www.perplexity.ai',
  gemini:     'https://gemini.google.com',
  deepseek:   'https://chat.deepseek.com',
};

const AI_SCRIPTS = {
  chatgpt:    'content-scripts/chatgpt.js',
  claude:     'content-scripts/claude.js',
  grok:       'content-scripts/grok.js',
  perplexity: 'content-scripts/perplexity.js',
  gemini:     'content-scripts/gemini.js',
  deepseek:   'content-scripts/deepseek.js',
};

// tabMap: { [ai]: tabId }
let tabMap = {};

// pendingRequests: { [requestId]: { resolve, reject, timeoutId } }
const pendingRequests = {};

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [ai, id] of Object.entries(tabMap)) {
    if (id === tabId) delete tabMap[ai];
  }
});

async function ensureTab(ai) {
  let tabId = tabMap[ai];

  if (tabId !== undefined) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && !tab.discarded) return tabId;
    } catch {}
  }

  const tab = await chrome.tabs.create({ url: AI_URLS[ai], active: true });
  tabMap[ai] = tab.id;
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
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [AI_SCRIPTS[ai]],
    });
  } catch {
    // Script may already be injected
  }
}

async function sendToAI(ai, message, requestId) {
  try {
    const tabId = await ensureTab(ai);
    await injectContentScript(tabId, ai);

    const response = await chrome.tabs.sendMessage(tabId, {
      type: 'WRAPPERR_INJECT',
      message,
      requestId,
    });

    return response?.text ?? '';
  } catch (err) {
    throw new Error(err.message || 'Failed to communicate with AI tab');
  }
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
    sendResponse({ status: 'connected' });
  }
});

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
