// Grok capture rule. MAIN-world, document_start, host-scoped to grok.com via manifest.
//
// Purpose: tell the generic net hook (_wrapperr-net-hook.js) which URLs on grok.com it is
// allowed to tee. Without this rule, grok.com falls through to legacyLooksStreamy() which
// accepts ANY application/json that smells like a stream — that would pull in monitoring,
// engage, t/?verbose, rate-limits, share_links, list, conversations?pageSize (all visible in
// the Network tab during a normal Grok session) and pollute the parser buffer.
//
// The streaming response we actually want is the POST to
// /rest/app-chat/conversations/<uuid>/responses (for follow-up messages) or
// /rest/app-chat/conversations/new (for the first message of a brand-new chat). The regex
// below allows only those two shapes; everything else on grok.com is dropped by default-deny.
//
// Race-safety: this file and the net hook both run at document_start in MAIN world. Load
// order between separate content_scripts entries is undefined in MV3, so we push to a shared
// array (creating it if it doesn't exist yet). The hook reads the array on every fetch.
(function () {
  (window.__wrapperrCaptureRules ||= []).push({
    provider: 'grok',
    // hostPattern is what flips grok.com into default-deny mode once any rule for it exists.
    hostPattern: /^https?:\/\/(?:[^/]*\.)?grok\.com\//i,
    // No contentTypes pin: Grok's chat stream is application/json (concatenated {"result":{...}}
    // objects, NOT SSE), and pinning would break it. The URL alone is specific enough — nothing
    // else on grok.com matches this path.
    urlPattern: /^https?:\/\/(?:[^/]*\.)?grok\.com\/rest\/app-chat\/conversations\/(?:new|[0-9a-f-]+\/responses)(?:\/|\?|$)/i,
  });
})();
