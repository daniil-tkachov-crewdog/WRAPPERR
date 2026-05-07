async function injectMessage(message) {
  const input = document.querySelector('textarea#chat-input')
    ?? document.querySelector('textarea[placeholder*="Send"]')
    ?? document.querySelector('textarea[placeholder*="Message"]')
    ?? document.querySelector('textarea');

  if (!input) throw new Error('DeepSeek input not found');

  input.focus();
  await sleep(200);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, message);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  await sleep(300);

  const sendBtn = document.querySelector('button[aria-label*="Send"]')
    ?? document.querySelector('button[type="submit"]')
    ?? [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label')?.toLowerCase().includes('send')
      );

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// waitForResponse: DeepSeek adaptive completion detection. Streaming = Stop button OR a scoped
// streaming/generating class on the last message itself (broad page-wide [class*="loading"]
// previously matched sidebar/skeleton loaders and pinned us forever). Short window after on→off
// transition; long fallback otherwise. initialCount gate prevents capturing prior responses.
async function waitForResponse() {
  const RESPONSE_SELECTOR =
    '[class*="ds-markdown"], [class*="message-content"], [class*="assistant"], [class*="ds-message-row"]:not([class*="user"])';
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

      const stopBtn = document.querySelector(
        'button[aria-label*="Stop"], div[role="button"][aria-label*="Stop"], button[class*="stop"]'
      );
      const lastIsStreaming = last && (
        last.matches('[class*="streaming"], [class*="generating"]') ||
        last.querySelector('[class*="streaming"], [class*="generating"]')
      );
      const streaming = !!(stopBtn || lastIsStreaming);
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
