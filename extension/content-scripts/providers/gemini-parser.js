// Gemini-only stream parser. Owns ALL Gemini response decoding.
//
// Why this file exists: like ChatGPT, Gemini gets its own strict parser so changes to other
// AIs' decoding physically cannot affect it. The generic wrapperrParseStreamBody used to host
// this logic; it's now duplicated here and the generic copy stays only for AIs still on the
// legacy pipeline (Claude/Grok/Perplexity/DeepSeek).
//
// Gemini's StreamGenerate response is application/json (NOT SSE). The body is one or more
// chunks concatenated, each chunk shaped:
//   <byte-count>[["wrb.fr", null, "<inner-escaped-json>", ...]]
// The inner JSON is itself a nested array; somewhere inside it is an entry shaped
//   ["rc_<id>", ["<assistant text so far>", ...], ...]
// CRITICAL behaviour: each chunk contains the FULL accumulated answer so far, not an append
// delta. Concatenating would duplicate. We take the LONGEST text seen across all chunks.
function parseGeminiStream(body) {
  if (!body || !body.includes('wrb.fr')) return '';

  // findRcText: walk the unescaped inner-JSON tree looking for ["rc_...", ["text", ...], ...].
  // Returns the longest such text encountered (defensive — some payloads carry multiple rc_*
  // candidates and we want the most complete one).
  function findRcText(data) {
    if (!Array.isArray(data)) return '';
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

  // extractFromArray: walk the outer chunk tree looking for ["wrb.fr", null, "<json>", ...].
  // Slot [2] is an escaped JSON STRING that we must JSON.parse to get the real payload tree.
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

  // Chunk walker: the body is <number>[...] segments concatenated with no real separator.
  // Track bracket depth (string-aware) to find each balanced top-level array, parse it, and
  // keep the longest extracted text. Simpler than building a full tokenizer.
  let best = '';
  let i = 0;
  while (i < body.length) {
    while (i < body.length && (body[i] === ' ' || body[i] === '\n' || body[i] === '\r')) i++;
    while (i < body.length && body[i] >= '0' && body[i] <= '9') i++;
    if (i >= body.length || body[i] !== '[') { i++; continue; }

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

// readBestGeminiText: walk the bus-mirror buffers, parse each candidate with parseGeminiStream,
// and return the longest result. The 500 ms grace window covers clock skew between the SW's
// sentAt timestamp and the page's startedAt timestamps. Final pass goes through the shared
// normaliser so the Wrapperr UI gets the same Markdown shape every AI produces.
function readBestGeminiText(sentAt) {
  const cutoff = sentAt - 500;
  let best = '';

  const completed = window.__wrapperrCompleted || [];
  for (let i = completed.length - 1; i >= 0; i--) {
    const s = completed[i];
    if (s.startedAt < cutoff) continue;
    const t = parseGeminiStream(s.body);
    if (t && t.length > best.length) best = t;
  }
  const inProgress = window.__wrapperrInProgress;
  if (inProgress) {
    for (const s of inProgress.values()) {
      if (s.startedAt < cutoff) continue;
      const t = parseGeminiStream(s.body);
      if (t && t.length > best.length) best = t;
    }
  }

  return wrapperrNormalizeForProvider(best, 'gemini');
}
