async function injectMessage(message) {
  const input = document.querySelector('#prompt-textarea')
    ?? document.querySelector('textarea[data-id="root"]')
    ?? document.querySelector('div[contenteditable="true"]');
  if (!input) throw new Error('ChatGPT input not found');

  input.focus();

  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      'value'
    )?.set;
    if (setter) setter.call(input, message);
    else input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    // contenteditable (current ChatGPT uses ProseMirror-style div)
    input.textContent = '';
    document.execCommand('insertText', false, message);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
  }

  await sleep(300);

  const sendBtn = document.querySelector('[data-testid="send-button"]')
    ?? document.querySelector('button[aria-label="Send prompt"]')
    ?? document.querySelector('button[data-testid="fruitjuice-send-button"]')
    ?? document.querySelector('button[class*="send"]');

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// waitForResponse delegates to the shared MutationObserver helper. ChatGPT-specific signals:
//   - Response container: any [data-message-author-role="assistant"] bubble
//   - Streaming indicator: the Stop button rendered while a reply is generating
function waitForResponse(sentAt) {
  return wrapperrWaitForResponse({
    sentAt,
    urlMatch: (url) => /\/backend-api\/(f\/)?conversation/.test(url),
    responseSelector: '[data-message-author-role="assistant"]',
    getStreaming: () => !!document.querySelector(
      'button[aria-label*="Stop"], button[data-testid="stop-button"]'
    ),
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Guard against duplicate listeners. The service worker re-injects this script on every send
// (chrome.scripting.executeScript runs the file again whether or not it was already loaded).
// Without the guard, each send adds another onMessage listener and the same WRAPPERR_INJECT
// fires through all of them in parallel — typing duplicates into the composer and racing
// sendResponse calls.
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
