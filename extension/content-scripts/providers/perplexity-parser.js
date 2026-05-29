// Perplexity-only stream parser. Owns ALL Perplexity response decoding.
//
// Why this file exists: like ChatGPT, Gemini, and Grok, Perplexity gets its own strict parser
// so changes to other AIs' decoding physically cannot affect it. The generic
// wrapperrParseStreamBody stays only for AIs still on the legacy pipeline (Claude / DeepSeek).
//
// Perplexity's response shape: SSE (text/event-stream) where each event's `data:` line is a
// JSON object representing one server-sent update. The assistant text is built incrementally
// via RFC 6902 JSON Patch operations on a markdown_block whose `chunks` array is the prose
// broken into ordered string fragments:
//
//   event.blocks[i] = {
//     intended_usage: 'ask_text_0_markdown',
//     diff_block: {
//       field: 'markdown_block',
//       patches: [
//         { op: 'add', path: '/chunks/15', value: 'hree  \n\n- Pa' },
//         ...
//       ]
//     }
//   }
//
// The full answer = chunks[] sorted by numeric index, joined. Other blocks in the same event
// (plan, answer_tabs, pending_followups, classifier_results, ask_text duplicate, citation
// sources, follow-up suggestions, web_results) are excluded by strict intended_usage matching
// — same discipline that kept Grok's finalMetadata.followUpSuggestions from leaking into the
// answer.
//
// CRITICAL: refuse loose fallbacks like obj.delta / obj.token / obj.completion / obj.v. The
// ChatGPT migration's whole point was eliminating loose fallbacks that let bootstrap tokens
// contaminate replies.
function parsePerplexityStream(body) {
  if (!body || body.indexOf('ask_text_0_markdown') < 0) return '';

  // chunks: map of index -> string fragment. Map keeps insertion-agnostic semantics; we sort
  // by numeric index at the end so out-of-order arrival (rare but possible across reconnects)
  // doesn't scramble the prose.
  const chunks = new Map();

  // SSE framing: events are separated by a blank line (\n\n). Each event may have multiple
  // lines (event:, id:, data:); we only care about data: lines. JSON parses fail silently —
  // anything malformed is skipped, never substituted with a fallback.
  for (const rawEvent of body.split(/\n\n+/)) {
    if (!rawEvent.trim()) continue;
    let payload = '';
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('data:')) payload += line.slice(5).trimStart();
    }
    if (!payload || payload === '[DONE]') continue;

    let evt;
    try { evt = JSON.parse(payload); } catch { continue; }
    if (!evt || !Array.isArray(evt.blocks)) continue;

    for (const block of evt.blocks) {
      // Strict block filter: only the canonical ask_text_0_markdown block whose diff targets
      // markdown_block. The duplicate `ask_text` block carries the same patches; matching on
      // the canonical name (announced in top-level structured_answer_block_usages) avoids
      // double-counting and naturally excludes all non-prose blocks.
      if (!block || block.intended_usage !== 'ask_text_0_markdown') continue;
      const diff = block.diff_block;
      if (!diff || diff.field !== 'markdown_block' || !Array.isArray(diff.patches)) continue;

      for (const patch of diff.patches) {
        if (!patch || typeof patch.op !== 'string') continue;

        // Reset case: server replaces the whole markdown_block (initial seed or rare
        // mid-stream reset). Honour it by rebuilding the chunks map from the replacement.
        if (patch.op === 'replace' && patch.path === '' && patch.value &&
            Array.isArray(patch.value.chunks)) {
          chunks.clear();
          patch.value.chunks.forEach((v, i) => {
            if (typeof v === 'string') chunks.set(i, v);
          });
          continue;
        }

        // Append case: the typical streaming delta — one chunk index per event. Tight regex
        // pin on the path keeps citation/metadata patches from sneaking in even if Perplexity
        // ever shipped them with the same op.
        if (patch.op === 'add' && typeof patch.value === 'string' &&
            typeof patch.path === 'string') {
          const m = patch.path.match(/^\/chunks\/(\d+)$/);
          if (m) chunks.set(Number(m[1]), patch.value);
        }
      }
    }
  }

  if (chunks.size === 0) return '';
  const sorted = [...chunks.keys()].sort((a, b) => a - b);
  return sorted.map((i) => chunks.get(i)).join('');
}

// readBestPerplexityText: walk the bus-mirror buffers, parse each candidate with
// parsePerplexityStream, return the longest. The 500 ms grace covers clock skew between the
// SW's sentAt timestamp and the page's startedAt timestamps. Final pass goes through the
// shared normalizer; no Perplexity branch is needed because the reconstructed prose is
// already standard Markdown (citation markers like [1] are preserved as literal text).
function readBestPerplexityText(sentAt) {
  const cutoff = sentAt - 500;
  let best = '';

  const completed = window.__wrapperrCompleted || [];
  for (let i = completed.length - 1; i >= 0; i--) {
    const s = completed[i];
    if (s.startedAt < cutoff) continue;
    const t = parsePerplexityStream(s.body);
    if (t && t.length > best.length) best = t;
  }
  const inProgress = window.__wrapperrInProgress;
  if (inProgress) {
    for (const s of inProgress.values()) {
      if (s.startedAt < cutoff) continue;
      const t = parsePerplexityStream(s.body);
      if (t && t.length > best.length) best = t;
    }
  }

  return wrapperrNormalizeForProvider(best, 'perplexity');
}
