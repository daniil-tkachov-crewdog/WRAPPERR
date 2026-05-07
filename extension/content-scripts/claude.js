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

// waitForResponse delegates to the shared MutationObserver helper. Claude-specific signals:
//   - Response container: .font-claude-message bubbles (assistant only — user messages use a
//     different class)
//   - Streaming indicator: the last message's ancestor [data-is-streaming="true"]. We scope it
//     to the last message's ancestor chain so unrelated UI elsewhere on the page doesn't keep
//     us pinned forever.
function waitForResponse() {
  return wrapperrWaitForResponse({
    responseSelector: '.font-claude-message',
    getStreaming: (last) => last
      ? !!last.closest('[data-is-streaming="true"]')
      : !!document.querySelector('[data-is-streaming="true"]'),
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
