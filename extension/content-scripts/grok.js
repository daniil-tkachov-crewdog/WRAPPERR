// injectMessage: Grok has migrated between textarea and contenteditable composers across
// redesigns. We try textarea selectors first (legacy), then contenteditable fallbacks (current).
// Each input type needs a different value-setting path: native value setter for textarea,
// document.execCommand('insertText') for contenteditable, otherwise React state won't update.
async function injectMessage(message) {
  const input = document.querySelector('textarea[placeholder*="Ask"]')
    ?? document.querySelector('textarea[data-testid*="input"]')
    ?? document.querySelector('textarea[aria-label*="message"]')
    ?? document.querySelector('textarea')
    ?? document.querySelector('div[contenteditable="true"][role="textbox"]')
    ?? document.querySelector('[contenteditable="true"][aria-label*="Ask"]')
    ?? document.querySelector('[contenteditable="true"][aria-label*="message"]')
    ?? document.querySelector('[contenteditable="true"]');

  if (!input) throw new Error('Grok input not found');

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
    // Contenteditable path — clear, then insert via execCommand so React listeners fire.
    document.execCommand('selectAll', false, undefined);
    document.execCommand('delete', false, undefined);
    document.execCommand('insertText', false, message);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  }

  await sleep(300);

  const sendBtn = document.querySelector('button[aria-label*="Send"]')
    ?? document.querySelector('button[aria-label*="Submit"]')
    ?? document.querySelector('button[type="submit"]')
    ?? document.querySelector('button[data-testid*="send"]')
    ?? [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label')?.toLowerCase().includes('send')
      );

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// waitForResponse delegates to the shared MutationObserver helper. Grok-specific signals are
// the least reliable of any AI we drive — selectors here are speculative and may need a DOM
// dump to nail down. Streaming gate is the Stop button.
function waitForResponse(sentAt) {
  return wrapperrWaitForResponse({
    sentAt,
    // Grok endpoint pattern speculative; leave permissive.
    responseSelector:
      '[class*="message"][class*="assistant"], [data-message-author="grok"], [class*="response-content-markdown"], [class*="markdown"]',
    getStreaming: () => !!document.querySelector(
      'button[aria-label*="Stop"], button[aria-label*="stop"]'
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
