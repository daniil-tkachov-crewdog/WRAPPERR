// Shared helpers for the AI content scripts. Three responsibilities:
//   1. Bridge the MAIN-world fetch+WebSocket hook events into isolated-world state. Maintains
//      mirror buffers (in-progress streams + recently completed streams) so the content script
//      can answer GET_STATE polls synchronously without any cross-world async hops.
//   2. Provide wrapperrParseStreamBody(body) — a generic SSE/NDJSON parser that handles
//      ChatGPT, Claude, OpenAI-compat, and Gemini-style formats.
//   3. Provide wrapperrReadBestStreamText(sentAt) — picks the longest valid parsed text from
//      streams that started after sentAt.
//
// Key invariant: NO timers, NO async waits. The service worker drives all timing because tab
// throttling makes every setTimeout/setInterval in this context unreliable.
(() => {
  if (window.__wrapperrNetBusInited) return;
  window.__wrapperrNetBusInited = true;

  // Mirror buffers exposed on window so the AI script's message handlers (and any future
  // synchronous reader) can inspect state without further hops.
  const inProgress = new Map();   // id -> { startedAt, url, body }
  const completed = [];           // ring buffer (last 5 closed streams)
  window.__wrapperrInProgress = inProgress;
  window.__wrapperrCompleted = completed;

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const m = event.data;
    if (!m || m.source !== 'wrapperr-net') return;

    if (m.type === 'start') {
      inProgress.set(m.id, { startedAt: m.startedAt, url: m.url, body: '' });
    } else if (m.type === 'chunk') {
      // Body in chunk events is cumulative — overwrite, don't append.
      const existing = inProgress.get(m.id);
      if (existing) existing.body = m.body;
      else inProgress.set(m.id, { startedAt: m.startedAt, url: m.url, body: m.body });
    } else if (m.type === 'end') {
      const completedAt = Date.now();
      const detail = { startedAt: m.startedAt, completedAt, url: m.url, body: m.body || '' };
      completed.push(detail);
      if (completed.length > 5) completed.shift();
      inProgress.delete(m.id);
    } else if (m.type === 'error') {
      inProgress.delete(m.id);
    }
  });
})();

// Generic SSE / streaming-JSON parser. Handles multiple AI streaming formats:
//   • ChatGPT web: message.content.parts (cumulative replace), JSON-patch delta ("v" key),
//     Responses API (response.output_text.delta with string delta, response.output_item.done)
//   • Claude: content_block_delta with delta.text
//   • OpenAI-compat: choices[0].delta.content
//   • Gemini: candidates[0].content.parts
//   • Generic: obj.text, obj.token, obj.completion
// Returns '' when nothing parses so the caller can fall back to DOM scraping.
// Defensively rejects JWT-shaped output (ChatGPT bootstrap token bleed-through).
function wrapperrParseStreamBody(body) {
  if (!body) return '';

  let result = '';
  let appendedAnything = false;
  let lastFullMessage = '';

  function tryExtract(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // ChatGPT web — JSON-patch delta format (the canonical streaming format):
    //   {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"text chunk"}, ...]}
    // Each delta event applies multiple ops. We only care about appends to the assistant text path.
    // Other ops (status changes, metadata) are ignored.
    if (obj.o === 'patch' && Array.isArray(obj.v)) {
      let patchText = '';
      for (const op of obj.v) {
        if (
          op &&
          op.p === '/message/content/parts/0' &&
          op.o === 'append' &&
          typeof op.v === 'string'
        ) {
          patchText += op.v;
        }
      }
      if (patchText) return { kind: 'append', text: patchText };
      return null; // patch event but no relevant op — skip, don't fall through
    }

    // ChatGPT web — compact follow-up delta after the patch establishes the path:
    //   {"v":"more text"}  (path implied to be /message/content/parts/0)
    // We only treat this as a chunk if `v` is a non-empty string AND no more specific shape matched.
    // Note: this is checked AFTER the patch handler so {"o":"patch","v":[...]} doesn't fall here.
    if (typeof obj.v === 'string' && obj.v && !obj.p) {
      return { kind: 'append', text: obj.v };
    }
    // ChatGPT — single-op compact delta: {"p":"/message/content/parts/0","o":"append","v":"text"}
    if (obj.p === '/message/content/parts/0' && obj.o === 'append' && typeof obj.v === 'string') {
      return { kind: 'append', text: obj.v };
    }

    // ChatGPT web — initial assistant message event (full message object, parts may be empty
    // until deltas patch them in). Used as a "replace" baseline; deltas append on top via the
    // separate result/append accumulator.
    if (obj.message?.content?.parts && Array.isArray(obj.message.content.parts)) {
      const joined = obj.message.content.parts.filter((p) => typeof p === 'string').join('');
      if (joined) return { kind: 'replace', text: joined };
    }

    // OpenAI Responses API — {"type":"response.output_text.delta","delta":"text fragment"}
    // delta is a plain string here, not an object.
    if (typeof obj.delta === 'string' && obj.delta) {
      return { kind: 'append', text: obj.delta };
    }
    // OpenAI Responses API — done events with full text on obj.text
    if (obj.type === 'response.output_text.done' && typeof obj.text === 'string' && obj.text) {
      return { kind: 'replace', text: obj.text };
    }
    if (obj.output_item?.content?.[0]?.type === 'text' && typeof obj.output_item.content[0].text === 'string') {
      const t = obj.output_item.content[0].text;
      if (t) return { kind: 'replace', text: t };
    }
    if (obj.response?.output?.[0]?.content?.[0]?.type === 'text') {
      const t = obj.response.output[0].content[0].text;
      if (typeof t === 'string' && t) return { kind: 'replace', text: t };
    }

    // Claude (Anthropic API)
    if (obj.type === 'content_block_delta' && typeof obj.delta?.text === 'string') {
      return { kind: 'append', text: obj.delta.text };
    }
    if (typeof obj.completion === 'string') {
      return { kind: 'replace', text: obj.completion };
    }

    // OpenAI-compat chat completions
    if (Array.isArray(obj.choices) && obj.choices[0]?.delta?.content) {
      return { kind: 'append', text: obj.choices[0].delta.content };
    }
    if (Array.isArray(obj.choices) && typeof obj.choices[0]?.text === 'string') {
      return { kind: 'append', text: obj.choices[0].text };
    }

    // Gemini
    if (Array.isArray(obj.candidates) && obj.candidates[0]?.content?.parts) {
      const parts = obj.candidates[0].content.parts;
      const text = parts.map((p) => p.text || '').join('');
      if (text) return { kind: 'append', text };
    }

    // Generic delta objects
    if (typeof obj.delta?.text === 'string') return { kind: 'append', text: obj.delta.text };
    if (typeof obj.delta?.content === 'string') return { kind: 'append', text: obj.delta.content };
    if (typeof obj.token === 'string' && obj.token) return { kind: 'append', text: obj.token };

    return null;
  }

  // Reject obviously-JWT-shaped chunks at the source so they never accumulate. ChatGPT's
  // conduit bootstrap can arrive as {"v":"<JWT>"} which would otherwise look like a normal
  // delta append.
  function chunkLooksLikeJWT(s) {
    if (!s || s.length < 80) return false;
    if (/\s/.test(s)) return false;
    const core = s.replace(/[.,;:]+$/, '');
    if (!core.startsWith('eyJ')) return false;
    return core.split('.').length >= 3;
  }

  function applyExtract(ext) {
    if (!ext) return;
    if (chunkLooksLikeJWT(ext.text)) return;
    if (ext.kind === 'append') {
      result += ext.text;
      appendedAnything = true;
    } else if (ext.kind === 'replace') {
      if (ext.text.length > lastFullMessage.length) lastFullMessage = ext.text;
    }
  }

  // SSE pass. Standard SSE separates events with blank lines; ChatGPT follows this spec.
  // We try each data: line individually first (handles single-line-per-event compact format),
  // then fall back to joining multi-line data: blocks (for multi-line JSON spanning one event).
  const blocks = body.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const unparsedDataLines = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trimStart();
      if (!payload || payload === '[DONE]') continue;
      try {
        const obj = JSON.parse(payload);
        applyExtract(tryExtract(obj));
      } catch {
        // Multi-line JSON value spanning one SSE block — accumulate for joined parse below.
        unparsedDataLines.push(payload);
      }
    }
    if (unparsedDataLines.length > 0) {
      const joined = unparsedDataLines.join('\n');
      if (joined && joined !== '[DONE]') {
        try {
          const obj = JSON.parse(joined);
          applyExtract(tryExtract(obj));
        } catch {}
      }
    }
  }

  // NDJSON fallback for non-SSE streaming formats.
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

  // Defensive JWT filter: ChatGPT's conduit bootstrap endpoint returns a bare JWT that can
  // bleed through if it arrives wrapped in a {"v":"..."} delta-shaped event. Real prose
  // contains whitespace; a JWT does not. We strip trailing punctuation (some endpoints
  // append a separator dot) before checking the eyJ-prefixed base64.dot.base64.dot.base64
  // shape.
  function looksLikeJWT(s) {
    if (!s) return false;
    const t = s.trim();
    if (t.length < 80) return false;
    if (/\s/.test(t)) return false;
    const core = t.replace(/[.,;:]+$/, '');
    if (!core.startsWith('eyJ')) return false;
    return core.split('.').length >= 3;
  }
  if (looksLikeJWT(result)) result = '';
  if (looksLikeJWT(lastFullMessage)) lastFullMessage = '';

  // Strip a JWT prefix if one is glued to the start of the assistant text. The conduit
  // bootstrap token sometimes appears as the first bytes of the conversation stream (the
  // chunk-level filter misses it because the chunk also contains real content after it).
  function stripLeadingJWT(s) {
    if (!s || !s.startsWith('eyJ')) return s;
    const m = s.match(/^(eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\.?/);
    if (m && m[0].length >= 80) return s.slice(m[0].length).replace(/^[\s.]+/, '');
    return s;
  }
  result = stripLeadingJWT(result);
  lastFullMessage = stripLeadingJWT(lastFullMessage);

  const best = lastFullMessage.length > result.length ? lastFullMessage : result;

  // Debug: set window.__wrapperrDebug = true in DevTools console to log stream parses.
  if (window.__wrapperrDebug) {
    console.log('[wrapperr] parseStreamBody result:', best.slice(0, 200),
      '| appendLen:', result.length, '| replaceLen:', lastFullMessage.length);
  }

  return best;
}

// wrapperrReadBestStreamText: synchronously returns the longest valid parsed assistant text
// from streams started at or after `sentAt`. Considers both in-progress and completed streams
// so growing WS responses are visible mid-stream. The optional `provider` arg enables
// provider-specific post-processing (e.g. converting ChatGPT's PUA link markers to markdown).
function wrapperrReadBestStreamText(sentAt, provider) {
  const cutoff = sentAt - 500; // small grace window in case clocks differ slightly
  let best = '';

  const completed = window.__wrapperrCompleted || [];
  for (let i = completed.length - 1; i >= 0; i--) {
    const s = completed[i];
    if (s.startedAt < cutoff) continue;
    const text = wrapperrParseStreamBody(s.body);
    if (text && text.length > best.length) best = text;
  }

  const inProgress = window.__wrapperrInProgress;
  if (inProgress) {
    for (const s of inProgress.values()) {
      if (s.startedAt < cutoff) continue;
      const text = wrapperrParseStreamBody(s.body);
      if (text && text.length > best.length) best = text;
    }
  }

  return wrapperrNormalizeForProvider(best, provider);
}

// Provider-aware normalizer. Each AI streams styled content (links, citations, etc.) in its
// own raw format. This function converts those provider-specific encodings into normalized
// Markdown so the Wrapperr UI can render every AI's output with one renderer. Add a new
// per-provider helper here when adding support for a new AI's styled output.
function wrapperrNormalizeForProvider(text, provider) {
  if (!text) return text;
  if (provider === 'chatgpt') return wrapperrNormalizeChatGPT(text);
  // claude / gemini / grok / perplexity / deepseek currently stream plain Markdown — no
  // post-processing needed. Add cases here as we discover provider-specific encodings.
  return text;
}

// ChatGPT encodes clickable links in content using PUA markers:
//   <type><label><url>
// where <type> is usually "url". Convert these to Markdown [label](url). Other types (cite,
// safe_url, etc.) fall back to just the label. During streaming the closing  may not
// have arrived yet — we drop any trailing incomplete marker so partially-formed PUA chars
// never reach the UI; the next poll will see the completed marker and render it properly.
function wrapperrNormalizeChatGPT(text) {
  const MARKER_RE = /([a-z_]+)([^]*)([^]*)/g;
  let out = text.replace(MARKER_RE, (_m, type, label, url) => {
    if (type === 'url' && url) return `[${label || url}](${url})`;
    return label || '';
  });
  // Trim from the first remaining (incomplete) marker to the end. Avoids showing raw PUA chars
  // mid-stream; the in-progress marker will complete on the next chunk.
  const orphan = out.indexOf('');
  if (orphan !== -1) out = out.slice(0, orphan);
  return out;
}

function wrapperrBestText(el) {
  const it = el?.innerText?.trim() ?? '';
  const tc = el?.textContent?.trim() ?? '';
  return tc.length > it.length ? tc : it;
}
