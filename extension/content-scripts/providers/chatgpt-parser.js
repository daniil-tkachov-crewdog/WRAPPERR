// ChatGPT-only stream parser. Owns ALL ChatGPT response decoding.
//
// Why this file exists: the generic wrapperrParseStreamBody in _wrapperr-shared.js accepts loose
// fallbacks (obj.delta, obj.token, any {"v":"<string>"}) so it can serve multiple AIs. That
// looseness is what historically let ChatGPT's Fernet bootstrap token bleed into assistant
// replies. By giving ChatGPT a dedicated strict parser that only honours its actual patch-op
// shape, no field outside the assistant content path can ever appear in the output, AND changes
// to other AIs' parsing physically cannot affect ChatGPT.
//
// Accepted shapes (everything else ignored):
//   {"o":"patch","v":[{"p":"/message/content/parts/0","o":"append|replace","v":"..."}]}
//   {"v":[{"p":"/message/content/parts/0","o":"append|replace","v":"..."}]}   (follow-up envelope)
//   {"p":"/message/content/parts/0","o":"append|replace","v":"..."}            (single op)
//   {"v":"..."}     ONLY after a path-establishing patch has been seen in the same stream
//   {"message":{"content":{"parts":["..."]}}}   (initial assistant message baseline)
function parseChatGPTStream(body) {
  if (!body) return '';
  let text = '';
  let baseline = '';
  let pathSeen = false;

  // apply: route one parsed SSE payload object to the right accumulator. Order matters: more
  // specific shapes are checked first so a {"v":[...]} envelope isn't mis-handled as the compact
  // {"v":"<string>"} delta form.
  function apply(obj) {
    if (!obj || typeof obj !== 'object') return;

    // Initial assistant message envelope — gives us a content baseline before any patches arrive.
    if (obj.message?.content?.parts && Array.isArray(obj.message.content.parts)) {
      const joined = obj.message.content.parts.filter((p) => typeof p === 'string').join('');
      if (joined.length > baseline.length) baseline = joined;
      return;
    }

    // Patch envelope: array of ops. Each op MUST target the assistant content path to be honoured.
    if (Array.isArray(obj.v)) {
      for (const op of obj.v) {
        if (!op || op.p !== '/message/content/parts/0' || typeof op.v !== 'string') continue;
        if (op.o === 'append') { text += op.v; pathSeen = true; }
        else if (op.o === 'replace') { text = op.v; pathSeen = true; }
      }
      return;
    }

    // Single inline op shape.
    if (obj.p === '/message/content/parts/0' && typeof obj.v === 'string') {
      if (obj.o === 'append') { text += obj.v; pathSeen = true; }
      else if (obj.o === 'replace') { text = obj.v; pathSeen = true; }
      return;
    }

    // Compact follow-up delta {"v":"..."}. Only accepted AFTER an explicit patch in the same
    // stream has established the path — this is the critical rule that prevents arbitrary
    // string fields (bootstrap tokens, resume tokens, etc.) from being slurped as content.
    if (typeof obj.v === 'string' && obj.v && !obj.p && pathSeen) {
      text += obj.v;
      return;
    }
  }

  // SSE block walk. ChatGPT separates events with a blank line; each event has one or more
  // data: lines whose payload is a JSON object.
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

// readBestChatGPTText: walk the bus-mirror buffers (filled by the MAIN-world fetch hook via
// postMessage; mirrored into window.__wrapperrInProgress / __wrapperrCompleted by the bus mirror
// in _wrapperr-shared.js), parse each candidate with parseChatGPTStream, and return the longest
// result for any stream that started at/after sentAt. The 500 ms grace window covers slight
// clock skew between the SW's sentAt timestamp and the page's startedAt timestamps.
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

  // Style normalisation stays in the shared normaliser so the Wrapperr UI renders every AI's
  // output through one consistent pipeline. Only the per-AI branches inside normalizeLinks etc.
  // run for the 'chatgpt' provider.
  return wrapperrNormalizeForProvider(best, 'chatgpt');
}
