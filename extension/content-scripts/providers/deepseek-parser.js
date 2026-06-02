// DeepSeek-only stream parser. Owns ALL DeepSeek response decoding.
//
// Why this file exists: the generic wrapperrParseStreamBody in _wrapperr-shared.js accepts loose
// fallbacks (obj.delta, obj.token, any {"v":"<string>"}) so it can serve legacy AIs. That
// looseness is what historically let ChatGPT's Fernet bootstrap token bleed into assistant
// replies. A dedicated strict DeepSeek parser only honours its actual JSON-Patch shape, so no
// field outside the assistant content path can ever appear in the output, AND changes to other
// AIs' parsing physically cannot affect DeepSeek.
//
// DeepSeek's wire protocol (text/event-stream over /api/v0/chat/completion):
//   event: ready|update_session|title|close       → control frames, ignored
//   data: {"v":{"response":{...,"fragments":[{"id":N,"type":"RESPONSE","content":"<first char>"}]}}}
//        ^ seed envelope: read fragments[-1].content as baseline, establishes the assistant path
//   data: {"p":"response/fragments/-1/content","o":"APPEND","v":"<delta>"}
//        ^ explicit path-establishing op: append v to text, mark pathSeen
//   data: {"v":"<delta>"}
//        ^ bare delta: implicit continuation of the LAST APPEND cursor; only honoured after
//          pathSeen is true. Without this gate, BATCH envelopes and bootstrap strings could leak.
//   data: {"p":"response","o":"BATCH","v":[...metadata...]}     → ignored
//   data: {"p":"response/status","o":"SET","v":"FINISHED"}      → ignored (control)
function parseDeepSeekStream(body) {
  if (!body) return '';
  let text = '';
  let baseline = '';
  let pathSeen = false;

  // apply: route one parsed SSE payload object to the right accumulator. Order matters — more
  // specific shapes are checked first so a seed envelope isn't mis-handled as the compact
  // {"v":"<string>"} delta form.
  function apply(obj) {
    if (!obj || typeof obj !== 'object') return;

    // Seed envelope. The first content-bearing frame nests the assistant message inside
    // v.response.fragments[-1].content. Reading it gives us the very first character that the
    // delta stream then appends to, and confirms the assistant path so pathSeen flips on.
    if (obj.v && typeof obj.v === 'object' && obj.v.response && Array.isArray(obj.v.response.fragments)) {
      const frags = obj.v.response.fragments;
      const last = frags[frags.length - 1];
      if (last && typeof last.content === 'string' && last.content.length > baseline.length) {
        baseline = last.content;
      }
      pathSeen = true;
      return;
    }

    // Explicit path-establishing op. Only the assistant content path is honoured; APPEND ops on
    // other paths (status, accumulated_token_usage, etc.) are dropped by the path check.
    if (obj.p === 'response/fragments/-1/content' && obj.o === 'APPEND' && typeof obj.v === 'string') {
      text += obj.v;
      pathSeen = true;
      return;
    }

    // Compact follow-up delta {"v":"<string>"}. Only accepted AFTER the seed or an explicit
    // APPEND has established the path — this is the critical rule that prevents arbitrary string
    // fields (bootstrap tokens, session metadata, titles) from being slurped as content.
    if (typeof obj.v === 'string' && !obj.p && !obj.o && pathSeen) {
      text += obj.v;
      return;
    }

    // Anything else — BATCH on response, SET on response/status, control frames — ignored. No
    // obj.delta / obj.token / obj.completion fallbacks; this is the whole point of the strict
    // parser.
  }

  // SSE block walk. DeepSeek separates events with a blank line; each event may have an
  // `event: <name>` line plus one or more `data:` lines whose payload is a JSON object.
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

  // baseline + text both contribute: baseline is the seed's first char(s); text is the
  // concatenation of every APPEND that followed. Returning baseline + text preserves the very
  // first character which would otherwise be lost (the seed carries it, the deltas don't repeat it).
  return baseline + text;
}

// readBestDeepSeekText: walk the bus-mirror buffers (filled by the MAIN-world fetch/XHR hook via
// postMessage; mirrored into window.__wrapperrInProgress / __wrapperrCompleted by the bus mirror
// in _wrapperr-shared.js), parse each candidate with parseDeepSeekStream, and return the longest
// result for any stream that started at/after sentAt. The 500 ms grace covers slight clock skew
// between the SW's sentAt timestamp and the page's startedAt timestamps.
function readBestDeepSeekText(sentAt) {
  const cutoff = sentAt - 500;
  let best = '';

  const completed = window.__wrapperrCompleted || [];
  for (let i = completed.length - 1; i >= 0; i--) {
    const s = completed[i];
    if (s.startedAt < cutoff) continue;
    const t = parseDeepSeekStream(s.body);
    if (t && t.length > best.length) best = t;
  }
  const inProgress = window.__wrapperrInProgress;
  if (inProgress) {
    for (const s of inProgress.values()) {
      if (s.startedAt < cutoff) continue;
      const t = parseDeepSeekStream(s.body);
      if (t && t.length > best.length) best = t;
    }
  }

  // Style normalisation stays in the shared normaliser so the Wrapperr UI renders every AI's
  // output through one consistent pipeline. Only the per-AI branches inside normalizeLinks etc.
  // run for the 'deepseek' provider.
  return wrapperrNormalizeForProvider(best, 'deepseek');
}
