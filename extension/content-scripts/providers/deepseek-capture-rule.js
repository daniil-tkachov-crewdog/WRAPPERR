// DeepSeek capture rule. MAIN-world, document_start, host-scoped to chat.deepseek.com via manifest.
//
// Purpose: tell the generic net hook (_wrapperr-net-hook.js) which URLs on chat.deepseek.com it is
// allowed to tee. Without this rule, chat.deepseek.com falls through to legacyLooksStreamy() which
// accepts ANY application/json that smells like a stream — that would pull in bootstrap, auth,
// telemetry, session updates, etc. and pollute the parser buffer with non-assistant content.
//
// The streaming response we actually want is the POST to /api/v0/chat/completion. The same URL is
// used for both the first message and follow-ups in a conversation (confirmed from a real session
// sample), so the urlPattern is a single exact match. Everything else on chat.deepseek.com is
// dropped by default-deny once any rule for the host exists.
//
// Race-safety: this file and the net hook both run at document_start in MAIN world. Load order
// between separate content_scripts entries is undefined in MV3, so we push to a shared array
// (creating it if it doesn't exist yet). The hook reads the array on every fetch/XHR.
(function () {
  (window.__wrapperrCaptureRules ||= []).push({
    provider: 'deepseek',
    // hostPattern is what flips chat.deepseek.com into default-deny mode once any rule for it exists.
    hostPattern: /^https?:\/\/(?:[^/]*\.)?chat\.deepseek\.com\//i,
    // urlPattern: only the chat-completion endpoint is teed. If DeepSeek ever splits first-message
    // vs follow-up into separate paths (like Grok's /new vs /<id>/responses), widen this regex.
    urlPattern: /^https?:\/\/(?:[^/]*\.)?chat\.deepseek\.com\/api\/v0\/chat\/completion(?:\/|\?|$)/i,
    // contentTypes pin: DeepSeek streams SSE (text/event-stream). The URL is unique to this
    // endpoint so the pin is belt-and-braces — if DeepSeek ever serves a non-streaming probe at
    // the same path, we still won't slurp it.
    contentTypes: ['text/event-stream'],
  });
})();
