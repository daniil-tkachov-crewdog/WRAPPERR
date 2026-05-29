// injectMessage: locate Perplexity's Lexical contenteditable composer and submit.
//
// Composer is Lexical (Meta's editor framework, sibling of ProseMirror/Tiptap). Forces the
// 'contenteditable-text' strategy in _wrapperr-input.js because Lexical's beforeinput
// interceptor drops insertHTML text payloads (honouring only the <p> structure) — using
// insertText instead routes through Lexical's own text path and the prose lands correctly.
async function injectMessage(message) {
  const input = document.querySelector('#ask-input')
    ?? document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]')
    ?? document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (!input) throw new Error('Perplexity input not found');

  await wrapperrInjectInput(input, { kind: 'text', text: message }, { strategy: 'contenteditable-text' });

  // Send button has aria-label="Submit" + type="button" (NOT type="submit" — it's not in a
  // form). Enter keydown fallback covers the rare case where the button is still :disabled
  // when we click.
  const sendBtn = document.querySelector('button[aria-label="Submit"][type="button"]')
    ?? document.querySelector('button[aria-label="Submit"]');

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// DOM-scrape fallback selector — last resort only. Perplexity renders Markdown as HTML, so
// innerText here loses formatting symbols. The grace window in getCurrentState exists to
// avoid hitting this path while the SSE buffer is still filling.
const RESPONSE_SELECTOR =
  '[class*="prose"], [class*="answer"], [class*="markdown"], .markdown';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/perplexity-parser.js. They are injected
// before this script by the service worker (see AI_SCRIPTS in background/service-worker.js)
// and expose the global readBestPerplexityText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// Perplexity's DOM renders markdown as HTML; falling back too early returns plain text and
// the SW considers it stable, discarding the markdown forever. 3 s grace mirrors the fix
// applied to Gemini and Grok for the same failure mode.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestPerplexityText(sentAt);
  if (netText) {
    window.__wrapperrPerplexityDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrPerplexityDomGrace) window.__wrapperrPerplexityDomGrace = now;
  if (now - window.__wrapperrPerplexityDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

// Message listener — guarded against double-installation if the script is re-injected.
// Same shape as gemini.js / grok.js: WRAPPERR_INJECT_ONLY captures baseline + injects,
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
