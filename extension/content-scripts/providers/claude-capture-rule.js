// Claude capture rule. MAIN-world, document_start, host-scoped to claude.ai via manifest.
//
// Purpose: tell the generic net hook (_wrapperr-net-hook.js) which URLs on claude.ai it is
// allowed to tee. Without this rule, claude.ai falls through to legacyLooksStreamy() which
// accepts ANY application/json-ish stream — that would slurp telemetry, /api/account, sync
// pings, and other non-assistant SSE and pollute the parser buffer.
//
// The streaming response we actually want is the POST to
//   /api/organizations/<org-uuid>/chat_conversations/<chat-uuid>/completion
// Confirmed from a real session sample, the SAME URL is used for both the first message and
// follow-ups within a conversation, so a single regex with [0-9a-f-]+ placeholders for both
// UUIDs covers every case. Anything else on claude.ai (account, organizations list, statsig,
// sync, etc.) is dropped by default-deny once any rule for the host exists.
//
// Race-safety: this file and the net hook both run at document_start in MAIN world. Load
// order between separate content_scripts entries is undefined in MV3, so we push to a shared
// array (creating it if it doesn't exist yet). The hook reads the array on every fetch/XHR.
(function () {
  (window.__wrapperrCaptureRules ||= []).push({
    provider: 'claude',
    // hostPattern is what flips claude.ai into default-deny mode once any rule for it exists.
    hostPattern: /^https?:\/\/(?:[^/]*\.)?claude\.ai\//i,
    // urlPattern: only the chat_conversations/<uuid>/completion endpoint is teed. Both UUIDs
    // are lowercase hex with dashes. If Claude ever splits first-message into a separate
    // /append_message or /create_completion path, widen this regex.
    urlPattern: /^https?:\/\/(?:[^/]*\.)?claude\.ai\/api\/organizations\/[0-9a-f-]+\/chat_conversations\/[0-9a-f-]+\/completion(?:\/|\?|$)/i,
    // contentTypes pin: Claude streams Anthropic SSE (text/event-stream). The URL is unique
    // to this endpoint so the pin is belt-and-braces — if Claude ever serves a non-streaming
    // probe (e.g. JSON 404 or rate-limit) at the same path, we still won't slurp it.
    contentTypes: ['text/event-stream'],
  });
})();
