async function injectMessage(message) {
  const input = document.querySelector('textarea[placeholder*="Ask"]')
    ?? document.querySelector('textarea[placeholder*="ask"]')
    ?? document.querySelector('textarea');

  if (!input) throw new Error('Perplexity input not found');

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

  const sendBtn = document.querySelector('button[aria-label="Submit"]')
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

async function waitForResponse() {
  await sleep(2500);

  return new Promise((resolve) => {
    let lastText = '';
    let stableCount = 0;

    const interval = setInterval(() => {
      // Perplexity uses prose blocks for answers
      const answers = document.querySelectorAll(
        '[class*="prose"], [class*="answer"], .markdown'
      );
      const last = answers[answers.length - 1];
      const text = last?.innerText?.trim() ?? '';

      // Check for loading indicator
      const isLoading = document.querySelector('[class*="loading"], [aria-label*="loading"]');
      if (isLoading) {
        stableCount = 0;
        lastText = text;
        return;
      }

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
