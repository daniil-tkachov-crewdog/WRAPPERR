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

// waitForResponse: Grok currently times out on capture (response selector candidates are speculative
// — the Grok DOM uses ambiguous classes). We add a generic "stop button" streaming gate (Grok shows
// a stop / square icon while generating), an 8-tick stability window, and broaden response-container
// selectors. If this still times out the user should share the final message DOM dump and we'll
// pin the selector in a follow-up.
async function waitForResponse() {
  await sleep(2000);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;
    const STABLE_TICKS = 8;
    const TICK_MS = 800;
    const HARD_TIMEOUT_MS = 240000;

    const interval = setInterval(() => {
      const messages = document.querySelectorAll(
        '[class*="message"][class*="assistant"], [data-message-author="grok"], [class*="response-content-markdown"], [class*="markdown"]'
      );
      const last = messages[messages.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const isStreaming = !!document.querySelector(
        'button[aria-label*="Stop"], button[aria-label*="stop"], [class*="loading"]'
      );
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
