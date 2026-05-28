// injectMessage: locate Grok's Tiptap/ProseMirror contenteditable composer and submit.
//
// All actual typing logic lives in _wrapperr-input.js (contenteditable strategy via
// execCommand('insertHTML') with <p>-wrapped lines). ProseMirror's mutation observer
// reconciles the DOM mutation cleanly — synthetic ClipboardEvent paste doesn't work
// cross-world (isolated content-script world is invisible to MAIN-world editors).
async function injectMessage(message) {
  const input = document.querySelector('div[data-testid="chat-input"] div[contenteditable="true"]')
    ?? document.querySelector('.tiptap.ProseMirror[contenteditable="true"]')
    ?? document.querySelector('div[contenteditable="true"][translate="no"]');
  if (!input) throw new Error('Grok input not found');

  await wrapperrInjectInput(input, { kind: 'text', text: message });

  // Send button has data-testid="chat-submit" + aria-label="Submit"; either is stable.
  // Enter keydown fallback exists for the rare case where the button is still :disabled
  // when we click (Tiptap binds Enter to submit on its own).
  const sendBtn = document.querySelector('button[data-testid="chat-submit"]')
    ?? document.querySelector('button[type="submit"][aria-label="Submit"]');

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// DOM-scrape fallback selector — last resort only. Grok renders Markdown as HTML, so reading
// innerText here loses formatting symbols (#, **, fence ticks). The grace window in
// getCurrentState exists precisely to avoid hitting this path while the network buffer is
// still filling.
const RESPONSE_SELECTOR =
  '[class*="message"][class*="assistant"], [data-message-author="grok"], [class*="response-content-markdown"], [class*="markdown"]';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/grok-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and
// expose the global readBestGrokText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// Grok's DOM renders markdown as HTML; falling back too early returns plain text and the SW
// considers it stable, discarding the markdown forever. 3 s grace mirrors Gemini's fix for
// the same failure mode.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestGrokText(sentAt);
  if (netText) {
    window.__wrapperrGrokDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrGrokDomGrace) window.__wrapperrGrokDomGrace = now;
  if (now - window.__wrapperrGrokDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

// Message listener — guarded against double-installation if the script is re-injected.
// Same shape as gemini.js / chatgpt.js: WRAPPERR_INJECT_ONLY captures baseline + injects,
// WRAPPERR_GET_STATE returns the current best response text for the SW's stability poller.
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
  });
}
