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

// waitForResponse: DeepSeek currently never captures — selectors picked the wrong container.
// We broaden the response-container set to include known DeepSeek markdown wrappers, treat the
// stop button (and thinking/loading classes) as the streaming gate, and apply the 8-tick /
// textContent strategy. If capture still fails the user should share the message DOM dump.
async function waitForResponse() {
  await sleep(2000);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;
    const STABLE_TICKS = 8;
    const TICK_MS = 800;
    const HARD_TIMEOUT_MS = 240000;

    const interval = setInterval(() => {
      const messages = document.querySelectorAll(
        '[class*="ds-markdown"], [class*="message-content"], [class*="assistant"], [class*="ds-message-row"]:not([class*="user"])'
      );
      const last = messages[messages.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const isStreaming = !!document.querySelector(
        'button[aria-label*="Stop"], [class*="thinking"], [class*="loading"], [class*="generating"]'
      );
      if (isStreaming) {
        stableCount = 0;
        lastText = text;
        return;
      }

      if (text && text === lastText) {
        stableCount++;
        if (stableCount >= STABLE_TICKS) {
          clearInterval(interval);
          resolve(text);
        }
      } else {
        lastText = text;
        stableCount = 0;
      }
    }, TICK_MS);

    setTimeout(() => {
      clearInterval(interval);
      resolve(lastText || 'No response received.');
    }, HARD_TIMEOUT_MS);
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
