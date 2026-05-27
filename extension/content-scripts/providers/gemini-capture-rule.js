// Gemini capture rule. MAIN-world, document_start, host-scoped to gemini.google.com via manifest.
//
// Purpose: tell the generic net hook (_wrapperr-net-hook.js) which URLs on gemini.google.com it
// is allowed to tee. Once this rule loads, the host switches to default-deny so unrelated POSTs
// (batchexecute, logs, feedback, RPC bootstrap) cannot pollute the parser buffer. Only the
// StreamGenerate response actually carries assistant text.
//
// Race-safety: same as ChatGPT — push into the shared __wrapperrCaptureRules array. Order of
// load between this file and the hook is undefined, so we create-or-append.
(function () {
  (window.__wrapperrCaptureRules ||= []).push({
    provider: 'gemini',
    hostPattern: /^https?:\/\/gemini\.google\.com\//i,
    // Gemini's chat stream endpoint always includes the literal substring "StreamGenerate" in the
    // path. No content-type pin: Gemini sends application/json (not SSE), and the URL is specific
    // enough on its own — nothing else on gemini.google.com matches this pattern.
    urlPattern:  /StreamGenerate/,
  });
})();
