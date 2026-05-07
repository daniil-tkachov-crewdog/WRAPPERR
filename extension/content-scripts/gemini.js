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

// waitForResponse delegates to the shared MutationObserver helper. Gemini-specific signals:
//   - Response container: .model-response-text and friends.
//   - Streaming = (loading indicator visible) OR (response-actions toolbar not yet rendered).
//     Gemini only renders the copy/thumbs/share toolbar AFTER generation completes, so its
//     appearance is a strong positive done-signal. Without this gate, Gemini truncates because
//     mid-stream pauses look like "stable text" before the response finishes.
function waitForResponse(sentAt) {
  return wrapperrWaitForResponse({
    sentAt,
    // Gemini's streaming endpoint URL is hard to pin down (Google internal RPC). Leave urlMatch
    // off — any streaming POST started after sentAt is a candidate.
    responseSelector: '.model-response-text, [class*="model-response"], .response-container',
    getStreaming: () => {
      const isLoading = !!document.querySelector(
        '[class*="loading-indicator"], .pending-message, [class*="thinking"]'
      );
      const hasActions = !!document.querySelector(
        'message-actions, [data-test-id*="response-actions"], button[aria-label*="Copy"], button[data-test-id*="copy-button"]'
      );
      return isLoading || !hasActions;
    },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

if (!window.__wrapperrAIListenerOn) {
  window.__wrapperrAIListenerOn = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type !== 'WRAPPERR_INJECT') return;

    (async () => {
      try {
        const sentAt = Date.now();
        await injectMessage(msg.message);
        const text = await waitForResponse(sentAt);
        sendResponse({ text });
      } catch (err) {
        sendResponse({ text: '', error: err.message });
      }
    })();

    return true;
  });
}
