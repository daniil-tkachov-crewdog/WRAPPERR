async function injectMessage(message) {
  // Claude uses a ProseMirror contenteditable div
  const input = document.querySelector('[contenteditable="true"].ProseMirror')
    ?? document.querySelector('div[contenteditable="true"][data-placeholder]')
    ?? document.querySelector('div[contenteditable="true"]');

  if (!input) throw new Error('Claude input not found');

  input.focus();
  await sleep(200);

  // Clear existing content
  document.execCommand('selectAll', false, undefined);
  document.execCommand('delete', false, undefined);

  // Insert text
  document.execCommand('insertText', false, message);

  await sleep(300);

  // Click send button
  const sendBtn = document.querySelector('button[aria-label="Send Message"]')
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

// waitForResponse: adaptive completion detection (200ms polling, short stability after a
// confirmed streaming on→off transition, longer fallback otherwise). Streaming is detected via
// the last message's ancestor `[data-is-streaming="true"]` — scoped so unrelated UI doesn't
// keep us pinned. initialCount gate prevents resolving on the previous assistant message.
async function waitForResponse() {
  const initialCount = document.querySelectorAll('.font-claude-message').length;

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

      const allMessages = document.querySelectorAll('.font-claude-message');
      if (allMessages.length <= initialCount) {
        setTimeout(tick, TICK_MS);
        return;
      }

      const last = allMessages[allMessages.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const streaming = last
        ? !!last.closest('[data-is-streaming="true"]')
        : !!document.querySelector('[data-is-streaming="true"]');
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
