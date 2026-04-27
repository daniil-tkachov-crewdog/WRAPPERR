async function injectMessage(message) {
  const input = document.querySelector('textarea[placeholder*="Ask"]')
    ?? document.querySelector('textarea[data-testid*="input"]')
    ?? document.querySelector('textarea');

  if (!input) throw new Error('Grok input not found');

  input.focus();
  await sleep(200);

  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value'
  )?.set;

  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, message);
    input.dispatchEvent(new Event('input', { bubbles: true }));
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

async function waitForResponse() {
  await sleep(2000);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;

    const interval = setInterval(() => {
      // Grok response containers
      const messages = document.querySelectorAll(
        '[class*="message"][class*="assistant"], [data-message-author="grok"]'
      );
      const last = messages[messages.length - 1];
      const text = last?.innerText?.trim() ?? '';

      if (text && text === lastText) {
        stableCount++;
        if (stableCount >= 4) {
          clearInterval(interval);
          resolve(text);
        }
      } else {
        lastText = text;
        stableCount = 0;
      }
    }, 800);

    setTimeout(() => {
      clearInterval(interval);
      resolve(lastText || 'No response received.');
    }, 90000);
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
