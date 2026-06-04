// injectMessage: locate DeepSeek's textarea composer and submit.
//
// All actual typing logic lives in _wrapperr-input.js (native-field strategy via the React
// prototype setter, auto-selected because the composer is a <textarea>). Plain `el.value = ...`
// is silently ignored by React-controlled inputs, which is why earlier versions of this file had
// the send button stay disabled — the helper handles that correctly in one place for every AI.
async function injectMessage(message) {
  // Locate the composer. DeepSeek uses a plain <textarea> with placeholder="Message DSeek" and
  // name="search". Hashed classes (_27c9245, d96f2d2a, …) change across builds so we don't rely
  // on them. Fallbacks cover the case where DeepSeek tweaks the placeholder copy.
  const input = document.querySelector('textarea[placeholder="Message DSeek"]')
    ?? document.querySelector('textarea[name="search"]')
    ?? document.querySelector('textarea[placeholder*="DSeek"]')
    ?? document.querySelector('textarea[placeholder*="Message"]')
    ?? document.querySelector('textarea');
  if (!input) throw new Error('DeepSeek input not found');

  await wrapperrInjectInput(input, { kind: 'text', text: message });

  // Send button is a <div role="button"> (not a real <button>), so document.querySelectorAll
  // ('button') misses it — that's why we filter by role. The ds-button--primary class marks the
  // send button specifically; ds-button--disabled flips off once the textarea has text. We pick
  // the first matching enabled candidate. Enter-keydown fallback exists in case React's onClick
  // handler ignores a synthetic .click() on a <div>.
  const sendBtn = [...document.querySelectorAll('div[role="button"].ds-button--primary')]
    .find((b) => !b.classList.contains('ds-button--disabled'));

  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// DOM-scrape fallback selector — last resort only. DeepSeek renders Markdown as HTML, so reading
// innerText here loses formatting symbols (#, **, fence ticks). The grace window in
// getCurrentState exists precisely to avoid hitting this path while the network buffer is still
// filling.
const RESPONSE_SELECTOR =
  '[class*="ds-markdown"], [class*="message-content"], [class*="assistant"], [class*="ds-message-row"]:not([class*="user"])';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/deepseek-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and expose
// the global readBestDeepSeekText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// DeepSeek's DOM renders markdown as HTML; falling back too early returns plain text and the SW
// considers it stable, discarding the markdown forever. 3 s grace mirrors Gemini's / Grok's fix
// for the same failure mode.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestDeepSeekText(sentAt);
  if (netText) {
    window.__wrapperrDeepSeekDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrDeepSeekDomGrace) window.__wrapperrDeepSeekDomGrace = now;
  if (now - window.__wrapperrDeepSeekDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

// readLatestResponse: see chatgpt.js. Network buffer preferred (DeepSeek's DOM strips markdown);
// DOM fallback uses the same RESPONSE_SELECTOR as getBaseline.
function readLatestResponse() {
  const netText = readBestDeepSeekText(0);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const last = messages[messages.length - 1];
  return last ? wrapperrBestText(last) : '';
}

// Message listener — guarded against double-installation if the script is re-injected.
// Same shape as gemini.js / chatgpt.js / grok.js: WRAPPERR_INJECT_ONLY captures baseline + injects,
// WRAPPERR_GET_STATE returns the current best response text for the SW's stability poller.
// WRAPPERR_REREAD_LATEST returns the freshest last-assistant-message text without any inject.
if (!window.__wrapperrAIListenerOn) {
  window.__wrapperrAIListenerOn = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'WRAPPERR_INJECT_ONLY') {
      (async () => {
        try {
          const baseline = getBaseline();
          await injectMessage(msg.message);
          sendResponse({ ok: true, baseline });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
    if (msg.type === 'WRAPPERR_GET_STATE') {
      try { sendResponse({ text: getCurrentState(msg) }); }
      catch (err) { sendResponse({ text: '', error: err.message }); }
      return false;
    }
    if (msg.type === 'WRAPPERR_REREAD_LATEST') {
      try { sendResponse({ text: readLatestResponse() }); }
      catch (err) { sendResponse({ text: '', error: err.message }); }
      return false;
    }
  });
}
