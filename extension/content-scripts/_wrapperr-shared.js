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

// Generic SSE / streaming-JSON parser. See top of file for supported formats. Returns '' when
// nothing parses cleanly so the caller can fall back to DOM scraping. Defensively rejects
// JWT-shaped output (ChatGPT's conduit bootstrap response) — those aren't assistant content.
function wrapperrParseStreamBody(body) {
  if (!body) return '';

  let result = '';
  let appendedAnything = false;
  let lastFullMessage = '';

  function tryExtract(obj) {
    if (!obj || typeof obj !== 'object') return null;
    if (obj.message?.content?.parts && Array.isArray(obj.message.content.parts)) {
      const joined = obj.message.content.parts.filter((p) => typeof p === 'string').join('');
      if (joined) return { kind: 'replace', text: joined };
    }
    if (obj.type === 'content_block_delta' && typeof obj.delta?.text === 'string') {
      return { kind: 'append', text: obj.delta.text };
    }
    if (typeof obj.completion === 'string') {
      return { kind: 'replace', text: obj.completion };
    }
    if (Array.isArray(obj.choices) && obj.choices[0]?.delta?.content) {
      return { kind: 'append', text: obj.choices[0].delta.content };
    }
    if (Array.isArray(obj.choices) && typeof obj.choices[0]?.text === 'string') {
      return { kind: 'append', text: obj.choices[0].text };
    }
    if (Array.isArray(obj.candidates) && obj.candidates[0]?.content?.parts) {
      const parts = obj.candidates[0].content.parts;
      const text = parts.map((p) => p.text || '').join('');
      if (text) return { kind: 'append', text };
    }
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
      if (ext.text.length > lastFullMessage.length) lastFullMessage = ext.text;
    }
  }

  // SSE pass.
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
      // Unparseable payload — skip. The previous fallback that appended raw text caused
      // ChatGPT conduit JWTs to bleed through as the response.
    }
  }

  // NDJSON fallback.
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

  // Defensive JWT filter.
  function looksLikeJWT(s) {
    if (!s || s.length < 100) return false;
    return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s.trim());
  }
  if (looksLikeJWT(result)) result = '';
  if (looksLikeJWT(lastFullMessage)) lastFullMessage = '';

  if (lastFullMessage.length > result.length) return lastFullMessage;
  return result;
}

// wrapperrReadBestStreamText: synchronously returns the longest valid parsed assistant text
// from streams started at or after `sentAt`. Considers both in-progress and completed streams
// so growing WS responses are visible mid-stream.
function wrapperrReadBestStreamText(sentAt) {
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

  return best;
}

function wrapperrBestText(el) {
  const it = el?.innerText?.trim() ?? '';
  const tc = el?.textContent?.trim() ?? '';
  return tc.length > it.length ? tc : it;
}
