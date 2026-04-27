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

async function waitForResponse() {
  await sleep(2000);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;
    const STABLE_TICKS = 4;
    const TICK_MS = 800;

    const interval = setInterval(() => {
      // Claude renders messages in divs with font-claude-message class or similar
      const messages = document.querySelectorAll(
        '[data-is-streaming="false"] .font-claude-message, .font-claude-message'
      );
      const allMessages = document.querySelectorAll('.font-claude-message');
      const last = allMessages[allMessages.length - 1];
      const text = last?.innerText?.trim() ?? '';

      // Also check for streaming indicator — if present, not done yet
      const isStreaming = document.querySelector('[data-is-streaming="true"]');
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
