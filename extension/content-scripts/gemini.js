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

// waitForResponse: Gemini-specific adaptive completion detection. The "streaming" state here
// combines two signals: a loading indicator visible OR the response-actions toolbar (copy /
// thumbs / share) NOT yet mounted. Gemini only renders the actions toolbar after generation
// completes, so its appearance is a strong positive done-signal. When we observe the streaming
// composite flip true→false during this call, we use the short stability window; otherwise the
// long fallback. initialCount gate prevents capturing the prior response.
async function waitForResponse() {
  const initialCount = document.querySelectorAll(
    '.model-response-text, [class*="model-response"], .response-container'
  ).length;

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

      const responses = document.querySelectorAll(
        '.model-response-text, [class*="model-response"], .response-container'
      );
      if (responses.length <= initialCount) {
        setTimeout(tick, TICK_MS);
        return;
      }

      const last = responses[responses.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const isLoading = !!document.querySelector(
        '[class*="loading-indicator"], .pending-message, [class*="thinking"]'
      );
      const hasActions = !!document.querySelector(
        'message-actions, [data-test-id*="response-actions"], button[aria-label*="Copy"], button[data-test-id*="copy-button"]'
      );
      const streaming = isLoading || !hasActions;

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
