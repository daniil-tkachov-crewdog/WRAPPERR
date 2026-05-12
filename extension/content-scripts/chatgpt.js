// injectMessage: locate ChatGPT's composer (textarea OR contenteditable) and submit the
// message. Fires native input events so React state updates correctly.
async function injectMessage(message) {
  const input = document.querySelector('#prompt-textarea')
    ?? document.querySelector('textarea[data-id="root"]')
    ?? document.querySelector('div[contenteditable="true"]');
  if (!input) throw new Error('ChatGPT input not found');

  input.focus();

  if (input.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(input, message);
    else input.value = message;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
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

// AI-specific selector for assistant message bubbles. Used both for baseline counting (so we
// don't return prior responses) and for DOM-scrape fallback when network capture yields nothing.
const RESPONSE_SELECTOR = '[data-message-author-role="assistant"]';

// parseChatGPTStream: strict ChatGPT-only parser. Accepts ONLY events that target the assistant
// message content path (/message/content/parts/0). Everything else in the SSE stream
// (resume_conversation_token, conduit JWTs, Fernet bootstrap tokens, telemetry events) is
// ignored by construction. This is intentionally stricter than the generic
// wrapperrParseStreamBody so changes to other AIs' parsing can never leak into ChatGPT, and
// so unrelated SSE events can never bleed token strings into the assistant text.
function parseChatGPTStream(body) {
  if (!body) return '';
  let text = '';
  let baseline = '';
  let pathSeen = false;

  // Apply one parsed SSE event payload object.
  function apply(obj) {
    if (!obj || typeof obj !== 'object') return;

    // Initial assistant message envelope — provides a content baseline before any patches.
    if (obj.message?.content?.parts && Array.isArray(obj.message.content.parts)) {
      const joined = obj.message.content.parts.filter((p) => typeof p === 'string').join('');
      if (joined.length > baseline.length) baseline = joined;
      return;
    }

    // Patch envelope: {"o":"patch","v":[...ops...]} or follow-up {"v":[...ops...]}.
    if (Array.isArray(obj.v)) {
      for (const op of obj.v) {
        if (!op || op.p !== '/message/content/parts/0' || typeof op.v !== 'string') continue;
        if (op.o === 'append') { text += op.v; pathSeen = true; }
        else if (op.o === 'replace') { text = op.v; pathSeen = true; }
      }
      return;
    }

    // Single inline op: {"p":"/message/content/parts/0","o":"append"|"replace","v":"..."}
    if (obj.p === '/message/content/parts/0' && typeof obj.v === 'string') {
      if (obj.o === 'append') { text += obj.v; pathSeen = true; }
      else if (obj.o === 'replace') { text = obj.v; pathSeen = true; }
      return;
    }

    // Compact follow-up delta {"v":"..."} — only accepted AFTER the path has been established
    // by an explicit patch in this stream. This prevents any unrelated string field (bootstrap
    // tokens, etc.) from being slurped as content.
    if (typeof obj.v === 'string' && obj.v && !obj.p && pathSeen) {
      text += obj.v;
      return;
    }
  }

  // Standard SSE block walk.
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trimStart();
      if (!payload || payload === '[DONE]') continue;
      try { apply(JSON.parse(payload)); } catch {}
    }
  }

  return text || baseline;
}

// readBestChatGPTText: walk the in-progress + completed network buffers (filled by the MAIN-world
// fetch hook), parse each with parseChatGPTStream, and return the longest result whose stream
// started at/after sentAt. Mirrors wrapperrReadBestStreamText but uses the strict parser.
function readBestChatGPTText(sentAt) {
  const cutoff = sentAt - 500;
  let best = '';

  const completed = window.__wrapperrCompleted || [];
  for (let i = completed.length - 1; i >= 0; i--) {
    const s = completed[i];
    if (s.startedAt < cutoff) continue;
    const t = parseChatGPTStream(s.body);
    if (t && t.length > best.length) best = t;
  }
  const inProgress = window.__wrapperrInProgress;
  if (inProgress) {
    for (const s of inProgress.values()) {
      if (s.startedAt < cutoff) continue;
      const t = parseChatGPTStream(s.body);
      if (t && t.length > best.length) best = t;
    }
  }

  // Style normalisation (PUA link markers etc.) is still owned by the shared normaliser.
  return wrapperrNormalizeForProvider(best, 'chatgpt');
}

// getBaseline: snapshot the assistant-message count + last text BEFORE injection, so the SW can
// distinguish the new response from any prior one.
function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// getCurrentState: synchronous read of the current best-known response text. Tries the network
// capture first (works in background tabs because WS frames fire onmessage handlers regardless
// of focus); falls back to DOM scraping when the parser yields nothing. Returns '' when neither
// path has produced a response distinct from the baseline yet.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestChatGPTText(sentAt);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Listener guard: see comment in shared file. SW re-injection would otherwise stack listeners.
if (!window.__wrapperrAIListenerOn) {
  window.__wrapperrAIListenerOn = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'WRAPPERR_INJECT_ONLY') {
      (async () => {
        try {
          const baseline = getBaseline();
          await injectMessage(msg.message);
          sendResponse({ ok: true, baseline });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
    if (msg.type === 'WRAPPERR_GET_STATE') {
      try {
        sendResponse({ text: getCurrentState(msg) });
      } catch (err) {
        sendResponse({ text: '', error: err.message });
      }
      return false;
    }
  });
}
