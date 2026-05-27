// MAIN-world fetch + XHR + WebSocket hook. Runs at document_start before any AI site script
// executes. Tees streaming responses so the body buffer grows in real time even when the tab
// is throttled, while the page's own consumer still receives unchanged data (its UI works as
// normal when focused).
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
  window.__wrapperrCaptureRules ||= [];

  const STREAMY_CT = ['text/event-stream', 'application/x-ndjson', 'application/jsonl'];
  const STREAMY_URL_PATTERNS = ['StreamGenerate', 'streamGenerateContent'];
  let counter = 0;

  function legacyLooksStreamy(ct, url) {
    if (!ct) return true;
    if (STREAMY_CT.some((t) => ct.includes(t))) return true;
    if (ct.includes('application/json') && STREAMY_URL_PATTERNS.some((p) => url.includes(p))) return true;
    return false;
  }

  function findMatchingRule(url, ct) {
    const rules = window.__wrapperrCaptureRules || [];
    for (const rule of rules) {
      if (!rule?.urlPattern?.test?.(url)) continue;
      if (rule.contentTypes && !rule.contentTypes.some((t) => ct.includes(t))) continue;
      return rule;
    }
    return null;
  }

  function hostIsMigrated(url) {
    const rules = window.__wrapperrCaptureRules || [];
    for (const rule of rules) {
      if (rule?.hostPattern?.test?.(url)) return true;
    }
    return false;
  }

  function shouldTeeFromCt(ct, url, channel) {
    const matched = findMatchingRule(url, ct);
    if (window.__wrapperrDebug) {
      const verdict = matched ? `allow (rule: ${matched.provider})` : (hostIsMigrated(url) ? 'deny (migrated host)' : 'legacy');
      console.log('[wrapperr-net]', channel, 'POST response ct:', ct || '(empty)', 'url:', url, '|', verdict);
    }
    if (matched) return true;
    if (hostIsMigrated(url)) return false;
    return legacyLooksStreamy(ct, url);
  }

  function shouldTee(response, url) {
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    return shouldTeeFromCt(ct, url, 'fetch');
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

  // -------- XMLHttpRequest observer --------
  // Gemini's StreamGenerate is dispatched via XHR, not fetch. We attach a readystatechange
  // observer to every XHR; we do NOT alter responseType / responseText / abort behaviour.
  // Reads happen ONLY through xhr.responseText inside try/catch — if the page set
  // responseType to 'arraybuffer'/'blob', that getter throws and we silently skip. The page's
  // own request flow is unchanged either way, so this can never break tab loading.
  if (!window.__wrapperrXHRHooked) {
    window.__wrapperrXHRHooked = true;
    try {
      const origOpen = XMLHttpRequest.prototype.open;
      const origSend = XMLHttpRequest.prototype.send;

      XMLHttpRequest.prototype.open = function (method, url) {
        try {
          this.__wrapperrMethod = (method || 'GET').toUpperCase();
          this.__wrapperrUrl = String(url || '');
        } catch {}
        return origOpen.apply(this, arguments);
      };

      XMLHttpRequest.prototype.send = function () {
        try {
          if (this.__wrapperrMethod === 'POST') attachXHRObserver(this);
        } catch {}
        return origSend.apply(this, arguments);
      };

      function attachXHRObserver(xhr) {
        const url = xhr.__wrapperrUrl || '';
        const id = ++counter;
        const startedAt = Date.now();
        let started = false;
        let lastLen = 0;
        let lastBody = '';
        let debuggedFirst = false;

        xhr.addEventListener('readystatechange', function () {
          try {
            // readyState 2 = HEADERS_RECEIVED. Decide whether to tee using the response
            // content-type; if not, never start, no further work for this xhr.
            if (!started && xhr.readyState >= 2) {
              const ct = (xhr.getResponseHeader && xhr.getResponseHeader('content-type') || '').toLowerCase();
              if (!shouldTeeFromCt(ct, url, 'xhr')) return;
              started = true;
              post({ type: 'start', id, url, startedAt });
            }
            if (!started) return;

            // States 3 (LOADING, partial) and 4 (DONE) both have readable responseText
            // for text MIME types. Skip silently if the page used a non-text responseType.
            if (xhr.readyState === 3 || xhr.readyState === 4) {
              let text = '';
              try { text = xhr.responseText || ''; } catch { text = ''; }
              if (text.length > lastLen) {
                lastLen = text.length;
                lastBody = text;
                if (window.__wrapperrDebug && !debuggedFirst) {
                  debuggedFirst = true;
                  console.log('[wrapperr-net] xhr first chunk url:', url, '\nbody prefix:\n', text.slice(0, 600));
                }
                post({ type: 'chunk', id, url, startedAt, body: text });
              }
              if (xhr.readyState === 4) {
                post({ type: 'end', id, url, startedAt, body: lastBody });
                if (window.__wrapperrDebug) console.log('[wrapperr-net] xhr end', url, 'bytes:', lastBody.length);
              }
            }
          } catch (e) {
            // Never let observer errors propagate to the page's own xhr handler chain.
            if (window.__wrapperrDebug) console.warn('[wrapperr-net] xhr observer error', e);
          }
        });
      }
    } catch (e) {
      if (window.__wrapperrDebug) console.warn('[wrapperr-net] xhr hook install failed', e);
    }
  }

  // -------- WebSocket hook --------
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
