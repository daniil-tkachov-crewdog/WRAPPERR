// injectMessage: Perplexity moved to a Lexical-based contenteditable composer in 2025;
// the legacy textarea selectors no longer match. We try textarea first for backward-compat,
// then contenteditable variants. React-controlled inputs require the native value setter
// (textarea) or document.execCommand('insertText') (contenteditable) for the framework to see
// the change.
async function injectMessage(message) {
  const input = document.querySelector('textarea[placeholder*="Ask"]')
    ?? document.querySelector('textarea[placeholder*="ask"]')
    ?? document.querySelector('textarea')
    ?? document.querySelector('div[contenteditable="true"][role="textbox"]')
    ?? document.querySelector('[contenteditable="true"][aria-label*="Ask"]')
    ?? document.querySelector('[contenteditable="true"][aria-placeholder]')
    ?? document.querySelector('[contenteditable="true"]');

  if (!input) throw new Error('Perplexity input not found');

  input.focus();
  await sleep(200);

  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (setter) setter.call(input, message);
    else input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false, undefined);
    document.execCommand('delete', false, undefined);
    document.execCommand('insertText', false, message);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  }

  await sleep(300);

  const sendBtn = document.querySelector('button[aria-label="Submit"]')
    ?? document.querySelector('button[aria-label*="Submit"]')
    ?? document.querySelector('button[aria-label*="Send"]')
    ?? document.querySelector('button[data-testid*="submit"]')
    ?? document.querySelector('button[type="submit"]')
    ?? [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label')?.toLowerCase().includes('submit')
          || b.getAttribute('aria-label')?.toLowerCase().includes('send')
      );

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// waitForResponse delegates to the shared MutationObserver helper. Perplexity-specific signals:
//   - Response container: prose / answer / markdown blocks.
//   - Streaming gate: Stop button OR broad spinner classes. The broad selectors here can be
//     noisy; if they match unrelated UI we may need to scope tighter in a follow-up.
function waitForResponse(sentAt) {
  return wrapperrWaitForResponse({
    sentAt,
    responseSelector: '[class*="prose"], [class*="answer"], [class*="markdown"], .markdown',
    getStreaming: () => !!document.querySelector(
      'button[aria-label*="Stop"], [class*="loading"], [aria-label*="loading"], [class*="Spinner"]'
    ),
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
