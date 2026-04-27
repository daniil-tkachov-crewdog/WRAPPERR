async function injectMessage(message) {
  // Find the input
  const input = document.querySelector('#prompt-textarea');
  if (!input) throw new Error('ChatGPT input not found');

  // Set value via React's synthetic event system
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, message);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  await sleep(300);

  // Click send button
  const sendBtn = document.querySelector('[data-testid="send-button"]')
    ?? document.querySelector('button[aria-label="Send prompt"]')
    ?? document.querySelector('button[class*="send"]');

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    // Fallback: press Enter
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

async function waitForResponse() {
  // Wait for streaming to start
  await sleep(1500);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;
    const STABLE_TICKS = 4;
    const TICK_MS = 800;

    const interval = setInterval(() => {
      // Get the last assistant message
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const last = messages[messages.length - 1];
      const text = last?.innerText?.trim() ?? '';

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

    // Hard timeout
    setTimeout(() => {
      clearInterval(interval);
      resolve(lastText || 'No response received.');
    }, 90000);
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
