async function injectMessage(message) {
  // Gemini uses a rich-textarea or .ql-editor
  const input = document.querySelector('rich-textarea .ql-editor')
    ?? document.querySelector('div[contenteditable="true"].ql-editor')
    ?? document.querySelector('[contenteditable="true"][data-placeholder]')
    ?? document.querySelector('[contenteditable="true"]');

  if (!input) throw new Error('Gemini input not found');

  input.focus();
  await sleep(200);

  // Clear
  document.execCommand('selectAll', false, undefined);
  document.execCommand('delete', false, undefined);

  // Insert text
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

async function waitForResponse() {
  await sleep(2000);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;

    const interval = setInterval(() => {
      // Gemini model response containers
      const responses = document.querySelectorAll(
        '.model-response-text, [class*="model-response"], .response-container'
      );
      const last = responses[responses.length - 1];
      const text = last?.innerText?.trim() ?? '';

      // Check for loading
      const isLoading = document.querySelector('[class*="loading-indicator"], .pending-message');
      if (isLoading) {
        stableCount = 0;
        lastText = text;
        return;
      }

      if (text && text === lastText) {
        stableCount++;
        if (stableCount >= 4) {
          clearInterval(interval);
          resolve(text);
        }
      } else {
        lastText = text;
        stableCount = 0;
      }
    }, 800);

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
