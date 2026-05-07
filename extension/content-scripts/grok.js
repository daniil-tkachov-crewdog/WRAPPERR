// injectMessage: Grok has migrated between textarea and contenteditable composers across
// redesigns. We try textarea selectors first (legacy), then contenteditable fallbacks (current).
// Each input type needs a different value-setting path: native value setter for textarea,
// document.execCommand('insertText') for contenteditable, otherwise React state won't update.
async function injectMessage(message) {
  const input = document.querySelector('textarea[placeholder*="Ask"]')
    ?? document.querySelector('textarea[data-testid*="input"]')
    ?? document.querySelector('textarea[aria-label*="message"]')
    ?? document.querySelector('textarea')
    ?? document.querySelector('div[contenteditable="true"][role="textbox"]')
    ?? document.querySelector('[contenteditable="true"][aria-label*="Ask"]')
    ?? document.querySelector('[contenteditable="true"][aria-label*="message"]')
    ?? document.querySelector('[contenteditable="true"]');

  if (!input) throw new Error('Grok input not found');

  input.focus();
  await sleep(200);

  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (setter) setter.call(input, message);
    else input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // Contenteditable path — clear, then insert via execCommand so React listeners fire.
    document.execCommand('selectAll', false, undefined);
    document.execCommand('delete', false, undefined);
    document.execCommand('insertText', false, message);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  }

  await sleep(300);

  const sendBtn = document.querySelector('button[aria-label*="Send"]')
    ?? document.querySelector('button[aria-label*="Submit"]')
    ?? document.querySelector('button[type="submit"]')
    ?? document.querySelector('button[data-testid*="send"]')
    ?? [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label')?.toLowerCase().includes('send')
      );

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// waitForResponse: Grok adaptive completion detection. Grok exposes the least reliable signals
// of any AI we drive — selectors are speculative. We try the Stop button as the streaming gate;
// if we observe the on→off transition, short stability window kicks in. Otherwise we fall back
// to the longer window. initialCount gate prevents capturing prior responses.
async function waitForResponse() {
  const RESPONSE_SELECTOR =
    '[class*="message"][class*="assistant"], [data-message-author="grok"], [class*="response-content-markdown"], [class*="markdown"]';
  const initialCount = document.querySelectorAll(RESPONSE_SELECTOR).length;

  return new Promise((resolve) => {
    const startTime = Date.now();
    const HARD_TIMEOUT_MS = 240000;
    const SHORT_STABLE_MS = 1500;
    const LONG_STABLE_MS = 6400;
    const TICK_MS = 200;

    let lastText = '';
    let lastChangeAt = Date.now();
    let sawStreamingEnd = false;
    let prevStreaming = false;
    let resolved = false;

    function tick() {
      if (resolved) return;
      const now = Date.now();
      const elapsed = now - startTime;

      if (elapsed >= HARD_TIMEOUT_MS) {
        finish(lastText || 'No response received.');
        return;
      }

      const messages = document.querySelectorAll(RESPONSE_SELECTOR);
      if (messages.length <= initialCount) {
        setTimeout(tick, TICK_MS);
        return;
      }

      const last = messages[messages.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const streaming = !!document.querySelector(
        'button[aria-label*="Stop"], button[aria-label*="stop"]'
      );
      if (prevStreaming && !streaming) sawStreamingEnd = true;
      prevStreaming = streaming;

      if (text !== lastText) {
        lastText = text;
        lastChangeAt = now;
      }

      const stableMs = now - lastChangeAt;
      const requiredStable = sawStreamingEnd ? SHORT_STABLE_MS : LONG_STABLE_MS;

      if (text && !streaming && stableMs >= requiredStable) {
        finish(text);
        return;
      }

      setTimeout(tick, TICK_MS);
    }

    function finish(text) {
      resolved = true;
      resolve(text);
    }

    setTimeout(tick, TICK_MS);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'WRAPPERR_INJECT') return;

  (async () => {
    try {
      await injectMessage(msg.message);
      const text = await waitForResponse();
      sendResponse({ text });
    } catch (err) {
      sendResponse({ text: '', error: err.message });
    }
  })();

  return true;
});
