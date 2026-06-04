// injectMessage: locate Claude's ProseMirror/Tiptap contenteditable and submit.
//
// All actual typing logic lives in _wrapperr-input.js. Claude's composer is a contenteditable
// <div> driven by ProseMirror+Tiptap, so we pass the 'contenteditable' strategy explicitly
// (execCommand insertHTML with paragraph-wrapped lines). Earlier versions of this file did
// their own execCommand('insertText') here, which Tiptap's mutation observer sometimes
// swallowed and left the send button disabled — the shared helper handles this in one place
// for every AI and matches the path ProseMirror expects.
async function injectMessage(message) {
  // Locate the composer. Confirmed from a live session sample: the editor is a
  // <div contenteditable="true" data-testid="chat-input" class="tiptap ProseMirror" …>.
  // We try data-testid first (Claude's own stable attribute), then the ProseMirror class,
  // then any contenteditable as a last resort.
  const input = document.querySelector('div[contenteditable="true"][data-testid="chat-input"]')
    ?? document.querySelector('div[contenteditable="true"].ProseMirror')
    ?? document.querySelector('div[contenteditable="true"][aria-label*="prompt"]')
    ?? document.querySelector('div[contenteditable="true"]');
  if (!input) throw new Error('Claude input not found');

  await wrapperrInjectInput(input, { kind: 'text', text: message, strategy: 'contenteditable' });

  // Send button: <button aria-label="Send message">. The button starts disabled and only
  // enables once Claude's editor state has registered the inserted text, so we poll briefly
  // before clicking. Enter-keydown fallback exists in case React's onClick handler ignores
  // a synthetic .click() — Claude's composer also submits on Enter.
  const sendBtn = await waitForEnabledSendButton(1000);

  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// waitForEnabledSendButton: polls for an enabled aria-label="Send message" button for up to
// timeoutMs. Required because Tiptap propagates the content change asynchronously — clicking
// too fast hits a disabled button and the click is a no-op (the previous failure mode).
async function waitForEnabledSendButton(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btn = document.querySelector('button[aria-label="Send message"]')
      ?? document.querySelector('button[aria-label="Send Message"]')
      ?? [...document.querySelectorAll('button')].find(
          (b) => b.getAttribute('aria-label')?.toLowerCase() === 'send message'
        );
    if (btn && !btn.disabled) return btn;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// DOM-scrape fallback selector — last resort only. Claude renders Markdown as HTML, so
// reading innerText here loses formatting symbols (#, **, fence ticks). The grace window in
// getCurrentState exists precisely to avoid hitting this path while the network buffer is
// still filling. Selector matches the assistant turn container historically used by Claude.
const RESPONSE_SELECTOR = '[data-testid="user-message"] ~ *, .font-claude-message, [data-test-render-count]';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/claude-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and
// expose the global readBestClaudeText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// Claude's DOM renders markdown as HTML; falling back too early returns plain text and the
// SW considers it stable, discarding the markdown forever. 3 s grace mirrors DeepSeek's /
// Gemini's / Grok's fix for the same failure mode.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestClaudeText(sentAt);
  if (netText) {
    window.__wrapperrClaudeDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrClaudeDomGrace) window.__wrapperrClaudeDomGrace = now;
  if (now - window.__wrapperrClaudeDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

// readLatestResponse: see chatgpt.js for the rationale. Used by Compare's per-slide recheck.
// Network buffer preferred (markdown fidelity); DOM fallback uses the same RESPONSE_SELECTOR
// as getBaseline so we always read whatever Claude is currently showing as the latest reply.
function readLatestResponse() {
  const netText = readBestClaudeText(0);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const last = messages[messages.length - 1];
  return last ? wrapperrBestText(last) : '';
}

// Message listener — guarded against double-installation if the script is re-injected.
// Same shape as gemini.js / chatgpt.js / grok.js / deepseek.js: WRAPPERR_INJECT_ONLY captures
// baseline + injects, WRAPPERR_GET_STATE returns the current best response text for the SW's
// stability poller.
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
      try { sendResponse({ text: getCurrentState(msg) }); }
      catch (err) { sendResponse({ text: '', error: err.message }); }
      return false;
    }
    if (msg.type === 'WRAPPERR_REREAD_LATEST') {
      try { sendResponse({ text: readLatestResponse() }); }
      catch (err) { sendResponse({ text: '', error: err.message }); }
      return false;
    }
  });
}
