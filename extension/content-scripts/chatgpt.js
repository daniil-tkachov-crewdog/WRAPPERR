async function injectMessage(message) {
  const input = document.querySelector('#prompt-textarea')
    ?? document.querySelector('textarea[data-id="root"]')
    ?? document.querySelector('div[contenteditable="true"]');
  if (!input) throw new Error('ChatGPT input not found');

  input.focus();

  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (setter) setter.call(input, message);
    else input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // contenteditable (current ChatGPT uses ProseMirror-style div)
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

// waitForResponse: poll the last assistant bubble until text stops changing AND no streaming
// indicator is present for STABLE_TICKS consecutive checks (~6.4s). ChatGPT shows a "Stop
// generating" / "Stop streaming" button while a response is being produced and removes it when
// done; we treat the presence of that button as a hard "still streaming" signal. We capture the
// longer of innerText / textContent because innerText silently drops content inside collapsed or
// off-screen blocks during streaming. The naive 4-tick / innerText-only version was firing during
// brief mid-stream pauses and capturing a partial response.
async function waitForResponse() {
  // Wait for streaming to start
  await sleep(1500);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;
    const STABLE_TICKS = 8;
    const TICK_MS = 800;
    const HARD_TIMEOUT_MS = 240000;

    const interval = setInterval(() => {
      const messages = document.querySelectorAll('[data-message-author-role="assistant"]');
      const last = messages[messages.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      // Stop button is rendered only while the response is streaming.
      const isStreaming = !!document.querySelector(
        'button[aria-label*="Stop"], button[data-testid="stop-button"]'
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
