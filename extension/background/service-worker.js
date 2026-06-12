// service-worker.js — Wrapperr extension background.
//
// Every catch in this file produces a structured WrapperrError (see errorOf / wrapperrError
// below) instead of a bare new Error(msg). The WRAPPERR_RESPONSE envelope still has an `error`
// field, but it now carries the object — wrapperr-bridge.js forwards `msg` whole, and
// web/lib/extension.ts normalises both legacy string and new object shapes.
//
// Why mirror the registry here instead of importScripts: MV3 module SWs (`type: 'module'`)
// don't expose importScripts, and `await import(chrome.runtime.getURL(...))` works but adds
// async startup risk. A 30-line mirror is the pragmatic call — keep in sync with
// extension/content-scripts/_wrapperr-errors.js and web/lib/errors.ts when adding codes.

const SW_ERR_REG = {
  SW_TAB_OPEN:            { scope: 'extension', stage: 'Open / reuse the AI tab',           message: 'Could not open or reuse the target AI tab.' },
  SW_TAB_NAVIGATE:        { scope: 'extension', stage: 'Navigate the AI tab',               message: 'AI tab did not navigate to the expected URL.' },
  SW_SCRIPT_INJECT:       { scope: 'extension', stage: 'Inject content scripts',            message: 'chrome.scripting.executeScript rejected.' },
  SW_SEND_INJECT:         { scope: 'extension', stage: 'Hand prompt to content script',     message: 'Could not reach the content script in the AI tab.' },
  AI_POLL_HARD_TIMEOUT:   { scope: 'ai-flow',   stage: 'Capture AI response',               message: 'AI did not produce a stable response within the polling window.' },
  AI_POLL_ONLY_BASELINE:  { scope: 'ai-flow',   stage: 'Capture AI response',               message: 'Only the prior message / "Thinking…" was captured.' },
  WRAPPERR_TAB_MISSING:   { scope: 'extension', stage: 'Forward response to Wrapperr',     message: 'Service worker had no Wrapperr tab to send the reply to.' },
  AI_REREAD_NO_TEXT:      { scope: 'ai-flow',   stage: 'Re-read latest response',           message: 'No assistant text found on the AI tab.' },
  UNKNOWN:                { scope: 'unknown',   stage: 'Unknown failure',                   message: 'Something went wrong.' },
};
function wrapperrError(code, partial) {
  const base = SW_ERR_REG[code] || SW_ERR_REG.UNKNOWN;
  const p = partial || {};
  return {
    code: code, at: Date.now(),
    scope: base.scope, stage: base.stage, message: base.message,
    hint: p.hint, details: p.details, cause: p.cause, ai: p.ai, requestId: p.requestId,
  };
}
// errorOf — turn any caught value into a WrapperrError. Content scripts already return WrapperrError
// objects directly (via _wrapperr-errors.js), so this is the catch-all for chrome-API failures and
// the rare bare throw.
function errorOf(err, fallbackCode, partial) {
  if (err && typeof err === 'object' && err.code && err.stage && err.scope) return err;
  const p = partial || {};
  if (err && err.message) {
    return wrapperrError(fallbackCode || 'UNKNOWN', Object.assign({}, p, {
      cause: { name: err.name, message: err.message, stack: err.stack },
    }));
  }
  return wrapperrError(fallbackCode || 'UNKNOWN', Object.assign({}, p, {
    cause: { message: typeof err === 'string' ? err : JSON.stringify(err) },
  }));
}

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
// Wrapped in errorOf with SW_TAB_OPEN / SW_TAB_NAVIGATE so the UI can distinguish "tab couldn't
// be opened" from "tab opened but didn't reach the AI URL".
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

  try {
    const tab = await chrome.tabs.create({ url: AI_URLS[ai], active: false });
    tabMap[ai] = tab.id;
    await persistTabMap();
    await waitForTabLoad(tab.id);
    await sleep(2000);
    return tab.id;
  } catch (err) {
    // Surface as SW_TAB_OPEN with the Chrome runtime error captured. Common cause: too many
    // tabs open / private-window restrictions / target URL blocked by enterprise policy.
    throw errorOf(err, 'SW_TAB_OPEN', { ai, details: { url: AI_URLS[ai] } });
  }
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

// injectContentScript: every AI gets shared helpers + the universal input module + the errors
// twin + its own script chain. _wrapperr-errors.js MUST come before any per-AI script so they
// can use wrapperrError() / toWrapperrError(). Failure here becomes SW_SCRIPT_INJECT — usually
// a host_permissions miss or a page CSP. We deliberately swallow re-injection SyntaxErrors
// (multiple sends into the same tab) but surface novel failures.
async function injectContentScript(tabId, ai) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [
        'content-scripts/_wrapperr-errors.js',
        'content-scripts/_wrapperr-shared.js',
        'content-scripts/_wrapperr-input.js',
        ...AI_SCRIPTS[ai],
      ],
    });
  } catch (err) {
    const m = err && err.message || '';
    // Re-declaration / already-injected: harmless — the load guard in each script makes the
    // second injection a no-op. Don't surface these.
    if (m.includes('already been injected') || m.includes('Identifier') || m.includes('has already been declared')) return;
    throw errorOf(err, 'SW_SCRIPT_INJECT', { ai, details: { tabId } });
  }
}

// sendToAI: ensures the AI's tab is alive, injects scripts, then asks the content script to
// apply per-AI options (best-effort) and inject the prompt. `options` is optional and may be
// undefined — the content script then just submits with the site's current state.
async function sendToAI(ai, message, requestId, options) {
  const tabId = await ensureTab(ai); // throws WrapperrError on tab fail
  await injectContentScript(tabId, ai); // throws WrapperrError on injection fail

  let injectResp;
  try {
    injectResp = await chrome.tabs.sendMessage(tabId, {
      type: 'WRAPPERR_INJECT_ONLY',
      message,
      requestId,
      options,
    });
  } catch (err) {
    const msg = err && err.message || '';
    if (msg.includes('Receiving end does not exist') || msg.includes('No tab with id')) {
      delete tabMap[ai];
      await persistTabMap();
    }
    throw errorOf(err, 'SW_SEND_INJECT', { ai, requestId, details: { tabId } });
  }

  if (!injectResp || !injectResp.ok) {
    // Content script already returned a WrapperrError; preserve it and tag the request id.
    const w = (injectResp && injectResp.error) ? injectResp.error : null;
    if (w && typeof w === 'object' && w.code) {
      throw Object.assign({}, w, { ai, requestId });
    }
    // Legacy string error from a content script that hasn't migrated yet.
    throw errorOf(new Error(injectResp && injectResp.error || 'Inject failed'), 'AI_INJECT_INPUT_NOT_FOUND', { ai, requestId });
  }

  const sentAt = Date.now();
  const baseline = injectResp.baseline || { count: 0, text: '' };
  return await pollForResponse(tabId, ai, sentAt, baseline, requestId);
}

// rereadFromAI: ensures the AI's tab and content script are alive, then asks the content script
// for the latest assistant message text via WRAPPERR_REREAD_LATEST. No injection, no polling —
// the content script returns whatever the network buffer or DOM currently holds for the last
// turn. Throws WrapperrError if the tab can't be reached or if nothing is found.
async function rereadFromAI(ai, requestId) {
  const tabId = await ensureTab(ai);
  await injectContentScript(tabId, ai);

  let resp;
  try {
    resp = await chrome.tabs.sendMessage(tabId, { type: 'WRAPPERR_REREAD_LATEST' });
  } catch (err) {
    const m = err && err.message || '';
    if (m.includes('Receiving end does not exist') || m.includes('No tab with id')) {
      delete tabMap[ai];
      await persistTabMap();
    }
    throw errorOf(err, 'SW_SEND_INJECT', { ai, requestId, details: { tabId, op: 'reread' } });
  }

  const text = (resp && resp.text || '').trim();
  if (!text) throw wrapperrError('AI_REREAD_NO_TEXT', { ai, requestId, details: { tabId } });
  return text;
}

// pollForResponse: poll the content script for the assistant text. Hard timeout becomes
// AI_POLL_HARD_TIMEOUT; finishing with only baseline becomes AI_POLL_ONLY_BASELINE — the UI can
// then offer the user a clear "Re-check from tab" action instead of a silent shrug.
async function pollForResponse(tabId, ai, sentAt, baseline, requestId) {
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
      const msg = err && err.message || '';
      if (msg.includes('Receiving end does not exist') || msg.includes('No tab with id')) {
        delete tabMap[ai];
        await persistTabMap();
        throw errorOf(err, 'SW_SEND_INJECT', { ai, requestId, details: { tabId, op: 'poll' } });
      }
      await sleep(POLL_MS);
      continue;
    }

    const text = (resp && resp.text || '').trim();

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

  if (!lastText) {
    throw wrapperrError('AI_POLL_HARD_TIMEOUT', {
      ai, requestId,
      details: { hardMs: HARD_MS, baselineCount: baseline.count },
    });
  }
  return lastText;
}

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
        // err is already a WrapperrError (from ensureTab / inject / poll) OR a thrown
        // WrapperrError-shaped object from the content script's sendResponse path.
        const w = errorOf(err, 'UNKNOWN', { ai, requestId });
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, error: w });
        sendResponse({ ok: false, error: w });
      });

    return true;
  }

  if (msg.type === 'WRAPPERR_REREAD') {
    const { ai, requestId } = msg;

    rereadFromAI(ai, requestId)
      .then((text) => {
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, response: text });
        sendResponse({ ok: true });
      })
      .catch((err) => {
        const w = errorOf(err, 'AI_REREAD_NO_TEXT', { ai, requestId });
        sendToWrapperrTab({ type: 'WRAPPERR_RESPONSE', requestId, error: w });
        sendResponse({ ok: false, error: w });
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
    (t) => t.url && (t.url.includes('onrender.com') || t.url.includes('localhost:3000'))
  );
  if (!target) return false;
  try {
    const res = await chrome.tabs.sendMessage(target.id, { type: 'WRAPPERR_PING' });
    return res && res.pong === true;
  } catch {
    return false;
  }
}

// sendToWrapperrTab — push a WRAPPERR_RESPONSE to every open Wrapperr web tab. If no Wrapperr
// tab is open we can't surface the WrapperrError to the user UI; we log it so the SW console
// still has the diagnosis when the user looks. The UI's BRIDGE_TIMEOUT will fire on its end.
async function sendToWrapperrTab(data) {
  const tabs = await chrome.tabs.query({});
  let delivered = false;
  for (const tab of tabs) {
    if (tab.url && (tab.url.includes('onrender.com') || tab.url.includes('localhost:3000'))) {
      delivered = true;
      chrome.tabs.sendMessage(tab.id, data).catch(() => {});
    }
  }
  if (!delivered && data && data.error) {
    console.warn('[wrapperr SW] WRAPPERR_TAB_MISSING — no Wrapperr web tab open; dropping error', data.error);
  }
}
