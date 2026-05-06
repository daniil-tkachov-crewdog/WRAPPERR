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

// waitForResponse: Perplexity's previous selector-loading combo was firing during stream pauses
// and the response container was overly generic (any .prose / .markdown). We tighten to answer
// blocks specifically, watch a Stop button as the streaming signal, broaden the loading sentinel,
// and use the 8-tick / textContent strategy shared by the other AIs.
async function waitForResponse() {
  await sleep(2500);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;
    const STABLE_TICKS = 8;
    const TICK_MS = 800;
    const HARD_TIMEOUT_MS = 240000;

    const interval = setInterval(() => {
      const answers = document.querySelectorAll(
        '[class*="prose"], [class*="answer"], [class*="markdown"], .markdown'
      );
      const last = answers[answers.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const isStreaming = !!document.querySelector(
        'button[aria-label*="Stop"], [class*="loading"], [aria-label*="loading"], [class*="Spinner"]'
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
