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

// waitForResponse delegates to the shared MutationObserver helper. DeepSeek-specific signals:
//   - Response container: ds-markdown / message-content / assistant rows.
//   - Streaming = Stop button OR scoped streaming/generating class on the last message. The
//     previous page-wide [class*="loading"] selector matched sidebar/skeleton loaders and
//     pinned waitForResponse forever.
function waitForResponse() {
  return wrapperrWaitForResponse({
    responseSelector:
      '[class*="ds-markdown"], [class*="message-content"], [class*="assistant"], [class*="ds-message-row"]:not([class*="user"])',
    getStreaming: (last) => {
      const stopBtn = document.querySelector(
        'button[aria-label*="Stop"], div[role="button"][aria-label*="Stop"], button[class*="stop"]'
      );
      const lastIsStreaming = last && (
        last.matches('[class*="streaming"], [class*="generating"]') ||
        last.querySelector('[class*="streaming"], [class*="generating"]')
      );
      return !!(stopBtn || lastIsStreaming);
    },
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
