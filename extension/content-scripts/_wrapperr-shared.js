// Shared helpers for the AI content scripts. Two responsibilities:
//   1. Bridge the MAIN-world fetch hook's window.postMessage events into in-isolated-world
//      EventTarget signals that waitForResponse can listen on.
//   2. Provide wrapperrWaitForResponse(), which races a network-based path (parses streamed
//      response bodies captured by the fetch hook) against a DOM-based path (MutationObserver
//      on the response container). Whichever produces non-empty text first wins.
//
// Why both paths: the network path works in fully background tabs (rAF doesn't matter) and is
// usually faster, but it depends on us correctly parsing each AI's streaming format. The DOM
// path is format-agnostic and works as a safety net when the network path's parser doesn't
// understand the response. Together they cover focused-tab perf and background-tab reliability.
(() => {
  // Idempotent setup — content scripts get re-injected via chrome.scripting.executeScript on
  // every send, so we guard with a flag on window.
  if (window.__wrapperrNetBusInited) return;
  window.__wrapperrNetBusInited = true;

  // EventTarget the wait helper subscribes to. Dispatches CustomEvent('streamComplete', detail).
  const bus = new EventTarget();
  window.__wrapperrNetBus = bus;

  // Track in-flight streams so we can accumulate chunks across postMessage events.
  const active = new Map();   // id -> { startedAt, url, body }
  const completed = [];       // ring buffer of last 5 completed streams (debug / late subscribers)
  window.__wrapperrCompletedStreams = completed;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m || m.source !== 'wrapperr-net') return;

    if (m.type === 'start') {
      active.set(m.id, { startedAt: m.startedAt, url: m.url, body: '' });
    } else if (m.type === 'end') {
      // The hook posts the full body in 'end' (it was buffering all along) — the start record
      // may be missing if our listener was registered after start fired, so use the end body.
      const completedAt = Date.now();
      const detail = { startedAt: m.startedAt, completedAt, url: m.url, body: m.body || '' };
      completed.push(detail);
      if (completed.length > 5) completed.shift();
      active.delete(m.id);
      bus.dispatchEvent(new CustomEvent('streamComplete', { detail }));
    } else if (m.type === 'error') {
      active.delete(m.id);
    }
  });
})();

// Generic SSE / streaming-JSON parser. Handles the formats used by ChatGPT, Claude, Gemini,
// DeepSeek, Grok, and Perplexity (with varying coverage — when a format doesn't match any
// known shape we return '' and the caller falls back to the DOM path).
//
// SSE events are blocks separated by blank lines. Each block has zero or more `data:` lines
// containing payloads. Final marker is often `data: [DONE]`.
//
// Format-specific extraction (tried in order, first match wins per event):
//   - ChatGPT: { message: { content: { parts: ["..."] }, status } } — full message replaces
//     each event; we keep the latest (longest non-empty parts).
//   - Claude SSE: { type: "content_block_delta", delta: { type: "text_delta", text: "..." } } —
//     deltas append.
//   - OpenAI-compat: { choices: [{ delta: { content: "..." } }] } — deltas append.
//   - Gemini-style: { candidates: [{ content: { parts: [{ text: "..." }] } }] } — replace.
//   - Generic: token / completion / text fields.
function wrapperrParseStreamBody(body) {
  if (!body) return '';

  // Some AIs use NDJSON instead of SSE — one JSON object per line, no `data:` prefix.
  // Try SSE first; if no events parse, fall back to NDJSON.
  let result = '';
  let appendedAnything = false;
  let lastFullMessage = '';

  function tryExtract(obj) {
    if (!obj || typeof obj !== 'object') return null;
    // ChatGPT — full message replace
    if (obj.message?.content?.parts && Array.isArray(obj.message.content.parts)) {
      const joined = obj.message.content.parts.filter((p) => typeof p === 'string').join('');
      if (joined) return { kind: 'replace', text: joined };
    }
    // Claude SSE: content_block_delta
    if (obj.type === 'content_block_delta' && typeof obj.delta?.text === 'string') {
      return { kind: 'append', text: obj.delta.text };
    }
    // Claude SSE: completion (older format)
    if (typeof obj.completion === 'string') {
      return { kind: 'replace', text: obj.completion };
    }
    // OpenAI-compatible streaming
    if (Array.isArray(obj.choices) && obj.choices[0]?.delta?.content) {
      return { kind: 'append', text: obj.choices[0].delta.content };
    }
    if (Array.isArray(obj.choices) && typeof obj.choices[0]?.text === 'string') {
      return { kind: 'append', text: obj.choices[0].text };
    }
    // Gemini-style candidates
    if (Array.isArray(obj.candidates) && obj.candidates[0]?.content?.parts) {
      const parts = obj.candidates[0].content.parts;
      const text = parts.map((p) => p.text || '').join('');
      if (text) return { kind: 'append', text };
    }
    // Generic
    if (typeof obj.delta?.text === 'string') return { kind: 'append', text: obj.delta.text };
    if (typeof obj.delta?.content === 'string') return { kind: 'append', text: obj.delta.content };
    if (typeof obj.text === 'string') return { kind: 'append', text: obj.text };
    if (typeof obj.token === 'string') return { kind: 'append', text: obj.token };
    return null;
  }

  function applyExtract(ext) {
    if (!ext) return;
    if (ext.kind === 'append') {
      result += ext.text;
      appendedAnything = true;
    } else if (ext.kind === 'replace') {
      // Keep the longest replacement seen (handles ChatGPT's incremental message updates).
      if (ext.text.length > lastFullMessage.length) lastFullMessage = ext.text;
    }
  }

  // SSE pass
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const payload = dataLines.join('\n');
    if (payload === '[DONE]') continue;
    try {
      const obj = JSON.parse(payload);
      applyExtract(tryExtract(obj));
    } catch {
      // Not JSON — could be a plain-text token. Append as-is if it looks like text.
      if (payload && payload.length < 1000) {
        result += payload;
        appendedAnything = true;
      }
    }
  }

  // NDJSON fallback if SSE didn't yield anything
  if (!appendedAnything && !lastFullMessage) {
    for (const line of body.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        applyExtract(tryExtract(obj));
      } catch {}
    }
  }

  // Replace mode wins if it produced more text than appended deltas.
  if (lastFullMessage.length > result.length) return lastFullMessage;
  return result;
}

// wrapperrWaitForResponse:
//   opts.responseSelector — querySelectorAll() target for assistant message containers (DOM path).
//   opts.getStreaming(last) — function that returns truthy while AI is generating (DOM path).
//   opts.urlMatch?(url) — optional filter for which streaming responses to consider (network path).
//   opts.parseNet?(body, url) — optional override for parser; defaults to wrapperrParseStreamBody.
//   opts.sentAt — timestamp captured BEFORE injectMessage. Network streams that started earlier
//     are ignored (those belong to prior messages).
//
// Resolves with the captured assistant text. Whichever path (network or DOM) produces non-empty
// text first wins.
function wrapperrWaitForResponse(opts) {
  const { responseSelector, getStreaming, urlMatch, parseNet, sentAt } = opts;
  const cutoff = sentAt || Date.now();
  const initialCount = document.querySelectorAll(responseSelector).length;

  return new Promise((resolve) => {
    const HARD_TIMEOUT_MS = 240000;
    const SHORT_STABLE_MS = 1500;
    const LONG_STABLE_MS = 6400;

    let lastText = '';
    let sawStreamingEnd = false;
    let prevStreaming = false;
    let resolved = false;
    let stableTimer = null;
    let observer = null;
    let netHandler = null;

    function finish(text) {
      if (resolved) return;
      resolved = true;
      if (observer) observer.disconnect();
      if (stableTimer) clearTimeout(stableTimer);
      if (netHandler) window.__wrapperrNetBus?.removeEventListener('streamComplete', netHandler);
      resolve(text);
    }

    // --- Network path ---
    netHandler = (event) => {
      if (resolved) return;
      const detail = event.detail || {};
      // Reject streams that started before the user's message was sent.
      if (detail.startedAt && detail.startedAt < cutoff - 500) return;
      if (urlMatch && !urlMatch(detail.url)) return;
      const parser = parseNet || wrapperrParseStreamBody;
      const text = parser(detail.body, detail.url);
      if (text && text.trim()) {
        finish(text);
      }
    };
    window.__wrapperrNetBus?.addEventListener('streamComplete', netHandler);

    // Late subscriber: check the ring buffer of recently-completed streams in case ours
    // finished between injectMessage and waitForResponse setup.
    const recent = window.__wrapperrCompletedStreams || [];
    for (let i = recent.length - 1; i >= 0; i--) {
      const detail = recent[i];
      if (detail.startedAt < cutoff - 500) continue;
      if (urlMatch && !urlMatch(detail.url)) continue;
      const parser = parseNet || wrapperrParseStreamBody;
      const text = parser(detail.body, detail.url);
      if (text && text.trim()) {
        // Defer to next tick so listeners are torn down cleanly via finish().
        setTimeout(() => finish(text), 0);
        return;
      }
    }

    // --- DOM path (MutationObserver) ---
    function evaluate() {
      if (resolved) return;

      const messages = document.querySelectorAll(responseSelector);
      if (messages.length <= initialCount) return;

      const last = messages[messages.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const streaming = !!getStreaming(last);
      if (prevStreaming && !streaming) sawStreamingEnd = true;
      prevStreaming = streaming;

      if (text !== lastText) lastText = text;

      if (stableTimer) clearTimeout(stableTimer);
      if (lastText && !streaming) {
        const win = sawStreamingEnd ? SHORT_STABLE_MS : LONG_STABLE_MS;
        stableTimer = setTimeout(() => {
          if (resolved) return;
          if (!getStreaming(last)) finish(lastText);
        }, win);
      }
    }

    observer = new MutationObserver(evaluate);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });
    evaluate();

    // Hard safety net.
    setTimeout(() => {
      if (!resolved) finish(lastText || 'No response received.');
    }, HARD_TIMEOUT_MS);
  });
}
