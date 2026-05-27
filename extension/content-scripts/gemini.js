// injectMessage: locate Gemini's rich-textarea / .ql-editor composer and submit.
async function injectMessage(message) {
  const input = document.querySelector('rich-textarea .ql-editor')
    ?? document.querySelector('div[contenteditable="true"].ql-editor')
    ?? document.querySelector('[contenteditable="true"][data-placeholder]')
    ?? document.querySelector('[contenteditable="true"]');
  if (!input) throw new Error('Gemini input not found');

  input.focus();
  await sleep(200);

  document.execCommand('selectAll', false, undefined);
  document.execCommand('delete', false, undefined);
  document.execCommand('insertText', false, message);

  await sleep(300);

  const sendBtn = document.querySelector('button[aria-label="Send message"]')
    ?? document.querySelector('button.send-button')
    ?? [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label')?.toLowerCase().includes('send')
      );

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

const RESPONSE_SELECTOR = '.model-response-text, [class*="model-response"], .response-container';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/gemini-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and expose
// the global readBestGeminiText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// Gemini's DOM renders markdown as HTML; innerText on the rendered DOM produces plain text
// with no markdown symbols. If we fall back to DOM before the wrb.fr chunks arrive in the
// network buffer, the SW receives plain text, calls it stable, and returns it — dropping all
// formatting. We delay DOM fallback by 3 s to give the network buffer time to fill.
// window.__wrapperrGeminiDomGrace is reset when network text becomes available, so fast
// responses (where a chunk lands in <3 s) still resolve promptly via network.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestGeminiText(sentAt);
  if (netText) {
    window.__wrapperrGeminiDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrGeminiDomGrace) window.__wrapperrGeminiDomGrace = now;
  if (now - window.__wrapperrGeminiDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

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
