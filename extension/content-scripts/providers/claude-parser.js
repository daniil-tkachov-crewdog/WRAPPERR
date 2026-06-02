// Claude-only stream parser. Owns ALL Claude response decoding.
//
// Why this file exists: the generic wrapperrParseStreamBody in _wrapperr-shared.js accepts
// loose fallbacks (obj.delta, obj.token, any {"v":"<string>"}) so it can serve legacy AIs.
// That looseness historically let bootstrap tokens bleed into assistant replies. A dedicated
// strict Claude parser only honours Anthropic's content_block_delta.text_delta path, so no
// other field (thinking, tool use, ping payloads, message_limit metadata) can ever appear in
// the output, AND changes to other AIs' parsing physically cannot affect Claude.
//
// Claude's wire protocol (text/event-stream over /api/organizations/<u>/chat_conversations/<u>/completion):
//   event: conversation_ready         → control, ignored
//   event: message_start              → ignored (we don't seed from here; first content block starts empty)
//   event: content_block_start        → ignored (content starts empty in the sample)
//   event: content_block_delta { delta: { type: "text_delta", text: "<delta>" } } → APPEND text
//   event: content_block_delta { delta: { type: "thinking_delta" | "input_json_delta" | ... } } → IGNORED
//   event: content_block_stop         → ignored
//   event: message_delta              → ignored (stop_reason metadata, not text)
//   event: message_limit              → ignored (quota metadata)
//   event: message_stop               → terminator, ignored
//   event: ping                       → ignored
function parseClaudeStream(body) {
  if (!body) return '';
  let text = '';

  // apply: route one parsed SSE payload object to the text accumulator. Only the exact
  // content_block_delta + text_delta shape contributes; everything else (thinking deltas,
  // tool use deltas, control frames) is dropped on purpose. This is the strictness that
  // prevents accidental contamination if Anthropic adds new delta types in the future.
  function apply(obj) {
    if (!obj || typeof obj !== 'object') return;
    if (obj.type !== 'content_block_delta') return;
    const d = obj.delta;
    if (!d || typeof d !== 'object') return;
    if (d.type !== 'text_delta') return;
    if (typeof d.text !== 'string') return;
    text += d.text;
  }

  // SSE block walk. Anthropic separates events with a blank line; each event has an
  // `event: <name>` line plus one `data:` line whose payload is a JSON object. We ignore
  // the `event:` label and key off the JSON `type` field — they always match, and that
  // way a partial frame (missing event: line) still parses correctly.
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

  return text;
}

// readBestClaudeText: walk the bus-mirror buffers (filled by the MAIN-world fetch/XHR hook
// via postMessage; mirrored into window.__wrapperrInProgress / __wrapperrCompleted by the
// bus mirror in _wrapperr-shared.js), parse each candidate with parseClaudeStream, and
// return the longest result for any stream that started at/after sentAt. The 500 ms grace
// covers slight clock skew between the SW's sentAt timestamp and the page's startedAt
// timestamps.
function readBestClaudeText(sentAt) {
  const cutoff = sentAt - 500;
  let best = '';

  const completed = window.__wrapperrCompleted || [];
  for (let i = completed.length - 1; i >= 0; i--) {
    const s = completed[i];
    if (s.startedAt < cutoff) continue;
    const t = parseClaudeStream(s.body);
    if (t && t.length > best.length) best = t;
  }
  const inProgress = window.__wrapperrInProgress;
  if (inProgress) {
    for (const s of inProgress.values()) {
      if (s.startedAt < cutoff) continue;
      const t = parseClaudeStream(s.body);
      if (t && t.length > best.length) best = t;
    }
  }

  // Style normalisation stays in the shared normaliser so the Wrapperr UI renders every AI's
  // output through one consistent pipeline. Only the per-AI branches inside the normaliser
  // run for the 'claude' provider.
  return wrapperrNormalizeForProvider(best, 'claude');
}
