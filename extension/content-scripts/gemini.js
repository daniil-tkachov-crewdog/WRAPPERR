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

// waitForResponse: Gemini truncated responses badly with the previous 4-tick / innerText-only
// approach because Gemini streams in bursts with multi-second pauses; the heuristic fired during a
// pause and captured ~1/3 of the answer. Now: STABLE_TICKS = 8 (~6.4s), reset whenever a loading
// indicator is visible, and additionally require the post-generation response-action toolbar
// (thumbs up/down, copy) to be rendered — Gemini only mounts that toolbar after streaming
// completes. Capture textContent in addition to innerText since virtualized blocks were being
// missed.
async function waitForResponse() {
  await sleep(2000);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;
    const STABLE_TICKS = 8;
    const TICK_MS = 800;
    const HARD_TIMEOUT_MS = 240000;

    const interval = setInterval(() => {
      const responses = document.querySelectorAll(
        '.model-response-text, [class*="model-response"], .response-container'
      );
      const last = responses[responses.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      // Loading: blue progress / pending bubble.
      const isLoading = !!document.querySelector(
        '[class*="loading-indicator"], .pending-message, [class*="thinking"]'
      );
      // Done-streaming signal: Gemini renders a toolbar (copy / thumbs / share) on the final
      // message only after generation completes. If we don't find it yet, keep waiting.
      const hasResponseActions = !!document.querySelector(
        'message-actions, [data-test-id*="response-actions"], button[aria-label*="Copy"], button[data-test-id*="copy-button"]'
      );

      if (isLoading || !hasResponseActions) {
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
