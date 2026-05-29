// Perplexity capture rule. MAIN-world, document_start, host-scoped to www.perplexity.ai via
// manifest.
//
// Purpose: tell the generic net hook (_wrapperr-net-hook.js) which URLs on perplexity.ai it
// is allowed to tee. Without this rule, perplexity.ai falls through to legacyLooksStreamy()
// which accepts anything that smells stream-shaped — and Perplexity has a LOT of background
// chatter (RUM telemetry, ask-complete, list_pinned_ask_threads, list_autosuggest,
// list_computer_tasks, suggestion polling, copilot RPCs) that would pollute the parser buffer
// the same way ChatGPT's bootstrap tokens did before the per-AI migration.
//
// The streaming endpoint is /rest/sse/perplexity_ask (POST, text/event-stream). The path is
// unique enough that no contentTypes pin is needed — same situation as Gemini's StreamGenerate.
//
// Race-safety: this file and the net hook both run at document_start in MAIN world. Load
// order between separate content_scripts entries is undefined in MV3, so we push to a shared
// array (creating it if it doesn't exist yet). The hook reads the array on every fetch.
(function () {
  (window.__wrapperrCaptureRules ||= []).push({
    provider: 'perplexity',
    // hostPattern is what flips www.perplexity.ai into default-deny once any rule exists.
    hostPattern: /^https?:\/\/(?:[^/]*\.)?perplexity\.ai\//i,
    // /rest/sse/perplexity_ask is THE answer-stream endpoint. Trailing group covers optional
    // trailing slash or query string so we don't accidentally exclude variants.
    urlPattern: /^https?:\/\/(?:[^/]*\.)?perplexity\.ai\/rest\/sse\/perplexity_ask(?:\/|\?|$)/i,
  });
})();
