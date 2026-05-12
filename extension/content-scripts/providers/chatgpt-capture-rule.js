// ChatGPT capture rule. MAIN-world, document_start, host-scoped to chatgpt.com via manifest.
//
// Purpose: tell the generic net hook (_wrapperr-net-hook.js) which URLs on chatgpt.com it is
// allowed to tee into the response buffer. Anything that doesn't match this rule is passed
// through untouched, no matter what content-type it returns.
//
// Why this exists: ChatGPT's page makes many JSON POSTs each turn (sentinel/ping, ces/v1/t,
// chat-requirements/prepare, chat-requirements/finalize, telemetry, connectors list, etc.).
// Several of those return long encrypted bootstrap tokens (gAAAAA... Fernet, eyJ... JWT). When
// the hook teed every JSON response, those tokens contaminated the parser buffer and bled into
// assistant replies on 2nd+ messages. By restricting capture to just /backend-api/(f/)?conversation
// with content-type text/event-stream, no bootstrap or telemetry response can ever reach the
// buffer in the first place.
//
// Race-safety: this file and the net hook both run at document_start in MAIN world. Load order
// between separate content_scripts entries is undefined in MV3, so we push to a shared array
// (creating it if it doesn't exist yet). The hook reads the array on every fetch, so even if
// this rule registers after the hook installs, it takes effect on the very next request.
(function () {
  (window.__wrapperrCaptureRules ||= []).push({
    provider: 'chatgpt',
    // hostPattern is also used by the hook to detect that this host has been migrated to the
    // registry; once at least one rule for the host exists, the host is in default-deny mode
    // (only allowlisted URLs are teed). Hosts with no rules fall through to the legacy
    // content-type sniffer so the other AIs keep working until each is migrated in turn.
    hostPattern: /^https?:\/\/(?:[^/]*\.)?chatgpt\.com\//i,
    urlPattern:  /^https?:\/\/(?:[^/]*\.)?chatgpt\.com\/backend-api\/(?:f\/)?conversation(?:\/|\?|$)/i,
    // ChatGPT's actual chat stream is always SSE; reject anything else even on the right URL.
    contentTypes: ['text/event-stream'],
  });
})();
