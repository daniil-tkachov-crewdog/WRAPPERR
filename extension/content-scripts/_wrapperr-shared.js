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
// Gemini wrb.fr parser — separate from the SSE path because Gemini's StreamGenerate endpoint
// uses chunked application/json, not text/event-stream. Each chunk has the form:
//   <byte-count>[["wrb.fr", null, "<inner-escaped-json>", ...]]
// The inner JSON contains rc_* arrays holding the full accumulated response text. Each chunk
// is a superset of the previous, so we take the longest candidate across all chunks.
// Returns '' if the body doesn't look like Gemini wrb.fr data.
function wrapperrParseGemini(body) {
  if (!body || !body.includes('wrb.fr')) return '';

  function findRcText(data) {
    if (!Array.isArray(data)) return '';
    // ["rc_XXXXX", ["full text so far", ...], ...]
    if (typeof data[0] === 'string' && data[0].startsWith('rc_') &&
        Array.isArray(data[1]) && typeof data[1][0] === 'string' && data[1][0].trim()) {
      return data[1][0];
    }
    let best = '';
    for (const item of data) {
      if (Array.isArray(item)) {
        const t = findRcText(item);
        if (t.length > best.length) best = t;
      }
    }
    return best;
  }

  function extractFromArray(arr) {
    if (!Array.isArray(arr)) return '';
    for (const item of arr) {
      if (!Array.isArray(item)) continue;
      if (item[0] === 'wrb.fr' && typeof item[2] === 'string') {
        try {
          const inner = JSON.parse(item[2]);
          const t = findRcText(inner);
          if (t) return t;
        } catch {}
      }
      const t = extractFromArray(item);
      if (t) return t;
    }
    return '';
  }

  // The body is one or more <number>[...] chunks concatenated. Walk through them by tracking
  // bracket depth — balanced JSON-array extraction without a full tokenizer.
  let best = '';
  let i = 0;
  while (i < body.length) {
    // Skip whitespace and digits (the byte-count prefix).
    while (i < body.length && (body[i] === ' ' || body[i] === '\n' || body[i] === '\r')) i++;
    while (i < body.length && body[i] >= '0' && body[i] <= '9') i++;
    if (i >= body.length || body[i] !== '[') { i++; continue; }

    // Find the balanced closing bracket for this chunk.
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < body.length; j++) {
      const c = body[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') { if (--depth === 0) { end = j; break; } }
    }
    if (end < 0) break;

    try {
      const chunk = JSON.parse(body.slice(i, end + 1));
      const t = extractFromArray(chunk);
      if (t.length > best.length) best = t;
    } catch {}
    i = end + 1;
  }
  return best;
}

function wrapperrParseStreamBody(body) {
  if (!body) return '';

  // Gemini fast-path: wrb.fr chunked JSON is structurally incompatible with SSE/NDJSON.
  // Check early and return so we don't waste time on the SSE pass.
  if (body.includes('wrb.fr')) {
    const geminiText = wrapperrParseGemini(body);
    if (geminiText) return geminiText;
  }

  let result = '';
  let appendedAnything = false;
  let lastFullMessage = '';

  function tryExtract(obj) {
    if (!obj || typeof obj !== 'object') return null;

    // ChatGPT web — JSON-patch delta format. Two shapes:
    //   Initial event:   {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append","v":"..."}, ...]}
    //   Follow-up event: {"v":[{"p":"/message/content/parts/0","o":"append","v":"..."}, ...]}
    // Both are arrays of patch ops; only the wrapper differs. We accept either.
    // Other ops (status changes, metadata) are ignored.
    if (Array.isArray(obj.v)) {
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

// =============================================================================
// NORMALIZER PIPELINE
// Raw provider stream → wrapperrNormalizeForProvider → standard Markdown → ReactMarkdown
//
// One function per style element. Each converts ALL providers' encodings of that element
// into standard Markdown. To add support for a new AI's custom encoding, add a branch
// inside the relevant style function — never scatter the logic elsewhere.
//
// Current non-standard encodings:
//   chatgpt  links: PUA markers U+E200 type U+E202 label U+E202 url U+E201
//   all others: already emit standard GFM Markdown — functions are pass-throughs
//   (add new branches here as more AIs are analysed)
// =============================================================================

// normalizeLinks: clickable links → [label](url)
// ChatGPT uses Private-Use-Area markers instead of Markdown links. All other providers
// already use standard Markdown syntax.
function normalizeLinks(text, provider) {
  if (provider !== 'chatgpt') return text;
  // PUA encoding: U+E200 <type> U+E202 <label> U+E202 <url> U+E201
  const SEP = '', OPEN = '', CLOSE = '';
  const MARKER_RE = /([a-z_]+)([^]*)([^]*)/g;
  let out = text.replace(MARKER_RE, (_m, type, label, url) => {
    if (type === 'url' && url) return `[${label || url}](${url})`;
    return label || '';
  });
  void SEP; void OPEN; void CLOSE; // referenced in MARKER_RE via template; keep lint happy
  const orphan = out.indexOf('');
  if (orphan !== -1) out = out.slice(0, orphan);
  return out;
}

// normalizeHeadings: # / ## / ### → ATX headings (standard for all providers)
function normalizeHeadings(text, _provider) { return text; }

// normalizeBoldItalic: **bold**, *italic*, ***both***, ~~strike~~ (standard for all)
function normalizeBoldItalic(text, _provider) { return text; }

// normalizeCode: `inline` and ``` fenced code blocks (standard for all providers)
function normalizeCode(text, _provider) { return text; }

// normalizeLists: bullet / numbered / nested / task checkboxes (standard GFM for all)
function normalizeLists(text, _provider) { return text; }

// normalizeBlockquotes: > prefix and warning/note callouts (standard for all providers)
function normalizeBlockquotes(text, _provider) { return text; }

// normalizeTables: GFM pipe tables (standard for all providers)
function normalizeTables(text, _provider) { return text; }

// normalizeLatex: $...$ inline and $$...$$ display math for KaTeX (standard for all)
function normalizeLatex(text, _provider) { return text; }

// wrapperrNormalizeForProvider: entry point that chains all per-style normalizers.
// Each step is responsible for exactly one style element. Output is always standard
// Markdown/GFM + KaTeX, fed directly to ReactMarkdown in the Wrapperr UI.
function wrapperrNormalizeForProvider(text, provider) {
  if (!text) return text;
  let out = text;
  out = normalizeLinks(out, provider);
  out = normalizeHeadings(out, provider);
  out = normalizeBoldItalic(out, provider);
  out = normalizeCode(out, provider);
  out = normalizeLists(out, provider);
  out = normalizeBlockquotes(out, provider);
  out = normalizeTables(out, provider);
  out = normalizeLatex(out, provider);
  return out;
}

function wrapperrBestText(el) {
  const it = el?.innerText?.trim() ?? '';
  const tc = el?.textContent?.trim() ?? '';
  return tc.length > it.length ? tc : it;
}
