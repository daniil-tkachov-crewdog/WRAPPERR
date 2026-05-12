// injectMessage: locate ChatGPT's composer (textarea OR contenteditable) and submit the
// message. Fires native input events so React state updates correctly.
async function injectMessage(message) {
  const input = document.querySelector('#prompt-textarea')
    ?? document.querySelector('textarea[data-id="root"]')
    ?? document.querySelector('div[contenteditable="true"]');
  if (!input) throw new Error('ChatGPT input not found');

  input.focus();

  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, message);
    else input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    input.textContent = '';
    document.execCommand('insertText', false, message);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  }

  await sleep(300);

  const sendBtn = document.querySelector('[data-testid="send-button"]')
    ?? document.querySelector('button[aria-label="Send prompt"]')
    ?? document.querySelector('button[data-testid="fruitjuice-send-button"]')
    ?? document.querySelector('button[class*="send"]');

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// AI-specific selector for assistant message bubbles. Used both for baseline counting (so we
// don't return prior responses) and for DOM-scrape fallback when network capture yields nothing.
const RESPONSE_SELECTOR = '[data-message-author-role="assistant"]';

// Stream parser + buffer reader live in providers/chatgpt-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and expose
// the global readBestChatGPTText() used below.

// getBaseline: snapshot the assistant-message count + last text BEFORE injection, so the SW can
// distinguish the new response from any prior one.
function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// getCurrentState: synchronous read of the current best-known response text. Tries the network
// capture first (works in background tabs because WS frames fire onmessage handlers regardless
// of focus); falls back to DOM scraping when the parser yields nothing. Returns '' when neither
// path has produced a response distinct from the baseline yet.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestChatGPTText(sentAt);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Listener guard: see comment in shared file. SW re-injection would otherwise stack listeners.
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
      try {
        sendResponse({ text: getCurrentState(msg) });
      } catch (err) {
        sendResponse({ text: '', error: err.message });
      }
      return false;
    }
  });
}
