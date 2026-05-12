// MAIN-world fetch + WebSocket hook. Runs at document_start before any AI site script
// executes. Tees streaming responses (fetch) and mirrors WebSocket frames so the body buffer
// grows in real time even when the tab is throttled, while the page's own consumer still
// receives unchanged data (its UI works as normal when focused).
//
// Architecture: keep the body buffer in MAIN world (so we don't repeatedly serialize big
// payloads to the isolated world), and emit lightweight `chunk` / `end` postMessage updates
// each time the cumulative body grows. The isolated-world shared script mirrors the buffer
// so it can be read synchronously when the service worker polls for state.
//
// Critical: NO setTimeout-based "stream end" detection in this file. Background-tab
// throttling clamps setTimeout to a 1s minimum and up to 1 minute under intensive throttling,
// so any timer here would freeze the pipeline. Stream stability is decided in the service
// worker (which is never throttled) by polling GET_STATE.
(() => {
  if (window.__wrapperrFetchHooked) return;
  window.__wrapperrFetchHooked = true;

  // -------- per-AI capture rule registry --------
  // Each per-AI MAIN-world rule file (e.g. providers/chatgpt-capture-rule.js) pushes one rule
  // here at document_start. A rule has the shape:
  //   { provider, hostPattern, urlPattern, contentTypes? }
  // hostPattern: identifies whether this host has any registered rules (migrated to the registry).
  // urlPattern:  the explicit URL allowlist for capture on this host.
  // contentTypes (optional): if present, response Content-Type must include one of these strings.
  // The hook reads __wrapperrCaptureRules on every request, so rules registered after the hook
  // installs still take effect on the next fetch.
  window.__wrapperrCaptureRules ||= [];

  // Legacy content-type sniffer. Used ONLY for hosts that have NOT registered any rule yet.
  // Once a host is migrated (any rule for its hostPattern is present), the hook switches to
  // default-deny for that host: only explicit allowlist matches are teed. This is what stops
  // bootstrap/telemetry/auth responses from polluting the parser buffer on migrated AIs without
  // affecting AIs that are still on the shared pipeline.
  const STREAMY_CT = ['text/event-stream', 'application/x-ndjson', 'application/jsonl'];
  const STREAMY_URL_PATTERNS = ['StreamGenerate', 'streamGenerateContent'];
  let counter = 0;

  function legacyLooksStreamy(ct, url) {
    if (!ct) return true;
    if (STREAMY_CT.some((t) => ct.includes(t))) return true;
    if (ct.includes('application/json') && STREAMY_URL_PATTERNS.some((p) => url.includes(p))) return true;
    return false;
  }

  // findMatchingRule: explicit allow — URL matches an allowlist entry AND (when the rule pins
  // content types) the response content-type matches one of the pinned values.
  function findMatchingRule(url, ct) {
    const rules = window.__wrapperrCaptureRules || [];
    for (const rule of rules) {
      if (!rule?.urlPattern?.test?.(url)) continue;
      if (rule.contentTypes && !rule.contentTypes.some((t) => ct.includes(t))) continue;
      return rule;
    }
    return null;
  }

  // hostIsMigrated: any rule whose hostPattern matches this URL means the host is in
  // default-deny mode (only allowlisted URLs are teed). Used to gate the legacy fallback.
  function hostIsMigrated(url) {
    const rules = window.__wrapperrCaptureRules || [];
    for (const rule of rules) {
      if (rule?.hostPattern?.test?.(url)) return true;
    }
    return false;
  }

  function shouldTee(response, url) {
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    const matched = findMatchingRule(url, ct);
    if (window.__wrapperrDebug) {
      const verdict = matched ? `allow (rule: ${matched.provider})` : (hostIsMigrated(url) ? 'deny (migrated host)' : 'legacy');
      console.log('[wrapperr-net] POST response ct:', ct || '(empty)', 'url:', url, '|', verdict);
    }
    if (matched) return true;
    if (hostIsMigrated(url)) return false;
    return legacyLooksStreamy(ct, url);
  }

  function post(payload) {
    try {
      window.postMessage(Object.assign({ source: 'wrapperr-net' }, payload), window.location.origin);
    } catch {}
  }

  // -------- fetch hook --------
  const origFetch = window.fetch.bind(window);
  window.fetch = async function wrapperrPatchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    if (method !== 'POST') return origFetch(input, init);

    let response;
    try { response = await origFetch(input, init); } catch (e) { throw e; }
    if (!response.body || !shouldTee(response, url)) return response;

    const id = ++counter;
    const startedAt = Date.now();
    post({ type: 'start', id, url, startedAt });

    let teed;
    try { teed = response.body.tee(); } catch { return response; }
    const [forPage, forUs] = teed;

    (async () => {
      const reader = forUs.getReader();
      const decoder = new TextDecoder();
      let body = '';
      let debuggedFirst = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            if (tail) body += tail;
            break;
          }
          body += decoder.decode(value, { stream: true });
          if (window.__wrapperrDebug && !debuggedFirst) {
            debuggedFirst = true;
            console.log('[wrapperr-net] first chunk url:', url, '\nbody prefix:\n', body.slice(0, 600));
          }
          post({ type: 'chunk', id, url, startedAt, body });
        }
        post({ type: 'end', id, url, startedAt, body });
        if (window.__wrapperrDebug) console.log('[wrapperr-net] fetch end', url, 'bytes:', body.length);
      } catch (e) {
        post({ type: 'error', id, url, startedAt, error: String(e) });
      }
    })();

    return new Response(forPage, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  // -------- WebSocket hook --------
  // ChatGPT and similar AIs deliver actual chat content over WS after a conduit-JWT POST.
  // We Proxy window.WebSocket so instanceof and most introspection still work, listen to
  // string frames, and emit `chunk` updates with the cumulative body on every frame. End
  // events fire on close/error only — never on an internal timer.
  const origWebSocket = window.WebSocket;
  if (origWebSocket && !window.__wrapperrWSHooked) {
    window.__wrapperrWSHooked = true;

    window.WebSocket = new Proxy(origWebSocket, {
      construct(target, args) {
        const ws = Reflect.construct(target, args);
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.toString?.() || '');
        if (!url || (!url.startsWith('wss://') && !url.startsWith('ws://'))) return ws;

        const id = ++counter;
        const startedAt = Date.now();
        let body = '';
        let endedFlag = false;

        function flushEnd() {
          if (endedFlag) return;
          endedFlag = true;
          post({ type: 'end', id, url, startedAt, body });
        }

        post({ type: 'start', id, url, startedAt });

        try {
          ws.addEventListener('message', (event) => {
            if (typeof event.data !== 'string' || !event.data) return;
            // Append a separator so SSE-style block parsing works on accumulated frames.
            body += event.data + '\n\n';
            post({ type: 'chunk', id, url, startedAt, body });
          });
          ws.addEventListener('close', flushEnd);
          ws.addEventListener('error', flushEnd);
        } catch {}

        return ws;
      },
    });
  }
})();
