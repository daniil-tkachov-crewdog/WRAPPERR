async function injectMessage(message) {
  // Claude uses a ProseMirror contenteditable div
  const input = document.querySelector('[contenteditable="true"].ProseMirror')
    ?? document.querySelector('div[contenteditable="true"][data-placeholder]')
    ?? document.querySelector('div[contenteditable="true"]');

  if (!input) throw new Error('Claude input not found');

  input.focus();
  await sleep(200);

  // Clear existing content
  document.execCommand('selectAll', false, undefined);
  document.execCommand('delete', false, undefined);

  // Insert text
  document.execCommand('insertText', false, message);

  await sleep(300);

  // Click send button
  const sendBtn = document.querySelector('button[aria-label="Send Message"]')
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

// waitForResponse: poll Claude's last assistant message and resolve once data-is-streaming has been
// false (or absent) for STABLE_TICKS consecutive checks AND the captured text has stopped
// changing. data-is-streaming is the most reliable "still generating" signal Claude exposes. We
// capture the longer of innerText / textContent so collapsed code blocks or wrapped content
// aren't missed.
async function waitForResponse() {
  await sleep(2000);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;
    const STABLE_TICKS = 8;
    const TICK_MS = 800;
    const HARD_TIMEOUT_MS = 240000;

    const interval = setInterval(() => {
      const allMessages = document.querySelectorAll('.font-claude-message');
      const last = allMessages[allMessages.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const isStreaming = !!document.querySelector('[data-is-streaming="true"]');
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
