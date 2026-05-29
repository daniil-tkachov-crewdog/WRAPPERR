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
// Two-tier extraction:
//   Tier 1 (preferred): the final SSE message (status:'COMPLETED', final_sse_message:true)
//   replaces diff_block with a fully-materialised markdown_block whose `.answer` is the
//   complete clean text. When present this is strictly better than chunk concatenation — it's
//   immune to missing-delta failures (slow start / reconnect / sentAt-cutoff edge cases).
//   Tier 2 (fallback while streaming): collect the diff patches and reconstruct from the
//   chunks map. This is what powers the live-updating UI before the COMPLETED event arrives.
//
// CRITICAL: refuse loose fallbacks like obj.delta / obj.token / obj.completion / obj.v. The
// ChatGPT migration's whole point was eliminating loose fallbacks that let bootstrap tokens
// contaminate replies.
function parsePerplexityStream(body) {
  if (!body || body.indexOf('ask_text_0_markdown') < 0) return '';

  // finalAnswer: longest fully-materialised markdown_block.answer seen across the stream.
  // chunks: map of index -> string fragment, the streaming-delta fallback.
  // Map keeps insertion-agnostic semantics; we sort by numeric index at the end so
  // out-of-order arrival (rare but possible across reconnects) doesn't scramble the prose.
  let finalAnswer = '';
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
      // Strict block filter: only the canonical ask_text_0_markdown block. The duplicate
      // `ask_text` block carries the same content; matching on the canonical name (announced
      // in top-level structured_answer_block_usages) avoids double-counting and naturally
      // excludes all non-prose blocks (plan, answer_tabs, pending_followups, classifier).
      if (!block || block.intended_usage !== 'ask_text_0_markdown') continue;

      // Tier 1: materialised markdown_block on the final event. `.answer` is the canonical
      // full text; `.chunks` is the array form (used as belt-and-braces if answer is missing).
      const md = block.markdown_block;
      if (md && typeof md === 'object') {
        if (typeof md.answer === 'string' && md.answer.length > finalAnswer.length) {
          finalAnswer = md.answer;
        } else if (Array.isArray(md.chunks)) {
          const joined = md.chunks.filter((c) => typeof c === 'string').join('');
          if (joined.length > finalAnswer.length) finalAnswer = joined;
        }
        continue;
      }

      // Tier 2: streaming diff. Only honoured when diff_block targets markdown_block —
      // refuses any other field so citation/metadata patches can't sneak in.
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

  // Prefer the materialised final answer when present (Tier 1). Falls back to the
  // delta-reconstructed chunks during streaming (Tier 2).
  if (finalAnswer) return finalAnswer;
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
