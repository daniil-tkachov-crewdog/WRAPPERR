// Grok-only stream parser. Owns ALL Grok response decoding.
//
// Why this file exists: like ChatGPT and Gemini, Grok gets its own strict parser so changes to
// other AIs' decoding physically cannot affect it. The generic wrapperrParseStreamBody stays
// only for AIs still on the legacy pipeline (Claude / Perplexity / DeepSeek).
//
// Grok's response shape: the body is a concatenation of JSON objects (no separator) with the
// shape {"result": {...}}. Three relevant kinds of "result":
//
//   1. Token deltas (during streaming):
//        { token: "...", isThinking: false, isSoftStop: false, messageTag: "final",
//          responseId: "..." }
//      Concatenate these (NOT cumulative — each is an append delta).
//      isThinking:true chunks belong to chain-of-thought and must be filtered out so they
//      don't leak into the user-visible answer.
//
//   2. Final message (end of stream):
//        { modelResponse: { message: "<full markdown>", ... }, ... }
//      This is the complete clean Markdown emitted in one shot. Strictly better than the
//      concatenated tokens (identical content, no risk of missing trailing chunks).
//
//   3. Bookkeeping ({ finalMetadata: {...} }, { isSoftStop: true }, etc.) — ignored.
//
// CRITICAL: refuse loose fallbacks like obj.delta / obj.token-without-guards / obj.completion.
// The ChatGPT migration's whole point was eliminating loose fallbacks that let bootstrap
// tokens contaminate replies. Same discipline applies here.
function parseGrokStream(body) {
  if (!body || body.indexOf('"result"') < 0) return '';

  // Bracket-depth JSON scanner. Body is {"result":{...}}{"result":{...}}... with no separator,
  // so we walk top-level balanced {...} objects. String-state tracking is required because
  // modelResponse.message is itself a long Markdown string containing literal { } [ ] (fenced
  // JSON code blocks, blockquote chars, etc.) — counting brackets inside strings would desync.
  // If the trailing object is incomplete (mid-stream), end < 0 and we stop cleanly without
  // losing already-parsed chunks.
  let finalMessage = '';
  let tokens = '';
  let i = 0;
  while (i < body.length) {
    while (i < body.length && body[i] !== '{') i++;
    if (i >= body.length) break;

    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < body.length; j++) {
      const c = body[j];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { if (--depth === 0) { end = j; break; } }
    }
    if (end < 0) break;

    try {
      const obj = JSON.parse(body.slice(i, end + 1));
      const r = obj && obj.result;
      if (r && typeof r === 'object') {
        // Tier 1: final clean Markdown blob. Longest wins so partial drafts can't overwrite a
        // complete one (defensive — in practice there's only one).
        if (r.modelResponse && typeof r.modelResponse.message === 'string' &&
            r.modelResponse.message.length > finalMessage.length) {
          finalMessage = r.modelResponse.message;
        }
        // Tier 2: token delta. STRICT guards — must be a final-tagged, non-thinking, string
        // token. Anything else (isThinking:true reasoning tokens, isSoftStop:true terminators,
        // missing messageTag) is excluded so chain-of-thought and stream-control noise can't
        // bleed into the answer.
        else if (typeof r.token === 'string' &&
                 r.isThinking === false &&
                 r.messageTag === 'final') {
          tokens += r.token;
        }
      }
    } catch {}
    i = end + 1;
  }

  // Prefer the final Markdown blob if it arrived; otherwise hand back what we've accumulated
  // from token deltas (which is what the SW polls see during streaming).
  return finalMessage || tokens;
}

// readBestGrokText: walk the bus-mirror buffers, parse each candidate with parseGrokStream,
// and return the longest. The 500 ms grace window covers clock skew between the SW's sentAt
// timestamp and the page's startedAt timestamps. Final pass goes through the shared normalizer
// so the Wrapperr UI gets the same Markdown shape every AI produces. Grok has no provider
// branch in the normalizer because modelResponse.message is already standard Markdown.
function readBestGrokText(sentAt) {
  const cutoff = sentAt - 500;
  let best = '';

  const completed = window.__wrapperrCompleted || [];
  for (let i = completed.length - 1; i >= 0; i--) {
    const s = completed[i];
    if (s.startedAt < cutoff) continue;
    const t = parseGrokStream(s.body);
    if (t && t.length > best.length) best = t;
  }
  const inProgress = window.__wrapperrInProgress;
  if (inProgress) {
    for (const s of inProgress.values()) {
      if (s.startedAt < cutoff) continue;
      const t = parseGrokStream(s.body);
      if (t && t.length > best.length) best = t;
    }
  }

  return wrapperrNormalizeForProvider(best, 'grok');
}
