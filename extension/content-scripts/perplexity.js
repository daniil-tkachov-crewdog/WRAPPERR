// injectMessage: Perplexity moved to a Lexical-based contenteditable composer in 2025;
// the legacy textarea selectors no longer match. We try textarea first for backward-compat,
// then contenteditable variants. React-controlled inputs require the native value setter
// (textarea) or document.execCommand('insertText') (contenteditable) for the framework to see
// the change.
async function injectMessage(message) {
  const input = document.querySelector('textarea[placeholder*="Ask"]')
    ?? document.querySelector('textarea[placeholder*="ask"]')
    ?? document.querySelector('textarea')
    ?? document.querySelector('div[contenteditable="true"][role="textbox"]')
    ?? document.querySelector('[contenteditable="true"][aria-label*="Ask"]')
    ?? document.querySelector('[contenteditable="true"][aria-placeholder]')
    ?? document.querySelector('[contenteditable="true"]');

  if (!input) throw new Error('Perplexity input not found');

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
    document.execCommand('selectAll', false, undefined);
    document.execCommand('delete', false, undefined);
    document.execCommand('insertText', false, message);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  }

  await sleep(300);

  const sendBtn = document.querySelector('button[aria-label="Submit"]')
    ?? document.querySelector('button[aria-label*="Submit"]')
    ?? document.querySelector('button[aria-label*="Send"]')
    ?? document.querySelector('button[data-testid*="submit"]')
    ?? document.querySelector('button[type="submit"]')
    ?? [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label')?.toLowerCase().includes('submit')
          || b.getAttribute('aria-label')?.toLowerCase().includes('send')
      );

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// waitForResponse: Perplexity adaptive completion detection. Streaming gate combines a Stop
// button and broad spinner classes; on the on→off transition we use the short stability window.
// initialCount gate prevents capturing prior answers.
async function waitForResponse() {
  const RESPONSE_SELECTOR = '[class*="prose"], [class*="answer"], [class*="markdown"], .markdown';
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

      const answers = document.querySelectorAll(RESPONSE_SELECTOR);
      if (answers.length <= initialCount) {
        setTimeout(tick, TICK_MS);
        return;
      }

      const last = answers[answers.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const streaming = !!document.querySelector(
        'button[aria-label*="Stop"], [class*="loading"], [aria-label*="loading"], [class*="Spinner"]'
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
