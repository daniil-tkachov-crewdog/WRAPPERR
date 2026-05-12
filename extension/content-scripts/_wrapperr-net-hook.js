// MAIN-world fetch + XHR + WebSocket hook. Runs at document_start before any AI site script
// executes. Tees streaming responses (fetch + XHR responseText) and mirrors WebSocket frames
// so the body buffer grows in real time even when the tab is throttled, while the page's own
// consumer still receives unchanged data (its UI works as normal when focused).
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

  const STREAMY_CT = ['text/event-stream', 'application/x-ndjson', 'application/jsonl'];
  let counter = 0;

  function looksStreamy(response) {
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (window.__wrapperrDebug) console.log('[wrapperr-net] POST response ct:', ct || '(empty)');
    if (!ct) return true;
    if (STREAMY_CT.some((t) => ct.includes(t))) return true;
    // Gemini streams over application/json with no event-stream content-type. Tee ALL JSON
    // POST responses on the page — the parser (wrb.fr detector) will ignore anything that
    // isn't actually a streaming response, so the cost is just a bit of extra buffering for
    // small JSON API calls.
    if (ct.includes('application/json')) return true;
    return false;
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
    if (!response.body || !looksStreamy(response)) return response;

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

  // -------- XHR hook --------
  // Some AI tabs (Gemini in particular) deliver chat responses via XMLHttpRequest, not fetch().
  // We patch open() to record method/url, then patch send() to attach a readystatechange listener.
  // While readyState === 3 (LOADING), responseText keeps growing — we post `chunk` updates with
  // the cumulative body so the SW-side parser sees it grow in real time. On readyState === 4
  // (DONE) we post `end`. Same content-type filter as fetch (stream-ish + any application/json).
  const XHRProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHRProto && !window.__wrapperrXHRHooked) {
    window.__wrapperrXHRHooked = true;
    const origOpen = XHRProto.open;
    const origSend = XHRProto.send;

    XHRProto.open = function wrapperrPatchedXHROpen(method, url) {
      try {
        this.__wrapperr = { method: String(method || 'GET').toUpperCase(), url: String(url || '') };
      } catch {}
      return origOpen.apply(this, arguments);
    };

    XHRProto.send = function wrapperrPatchedXHRSend() {
      const meta = this.__wrapperr;
      // Only POSTs are interesting — chat sends are always POST.
      if (!meta || meta.method !== 'POST') return origSend.apply(this, arguments);

      const id = ++counter;
      const startedAt = Date.now();
      const url = meta.url;
      let started = false;
      let lastLen = 0;
      let ctChecked = false;
      let ctOk = false;

      const onReady = () => {
        try {
          // readyState 2 = HEADERS_RECEIVED; first chance to inspect content-type.
          if (!ctChecked && this.readyState >= 2) {
            ctChecked = true;
            const ct = (this.getResponseHeader && (this.getResponseHeader('content-type') || '')).toLowerCase();
            if (window.__wrapperrDebug) console.log('[wrapperr-net] XHR POST response ct:', ct || '(empty)', 'url:', url);
            // Mirror looksStreamy(): allow empty CT, event-stream/ndjson/jsonl, and any JSON.
            if (!ct) ctOk = true;
            else if (STREAMY_CT.some((t) => ct.includes(t))) ctOk = true;
            else if (ct.includes('application/json')) ctOk = true;
            else if (ct.includes('text/plain')) ctOk = true; // Gemini sometimes labels wrb.fr as text/plain.
            if (!ctOk) return;
            started = true;
            post({ type: 'start', id, url, startedAt });
          }
          if (!ctOk) return;
          // responseText is only safe to read for text-ish responseTypes (default '' or 'text').
          if (this.responseType && this.responseType !== '' && this.responseType !== 'text') return;
          const txt = this.responseText || '';
          if (txt.length > lastLen) {
            lastLen = txt.length;
            if (window.__wrapperrDebug && txt.length > 0 && lastLen <= 600) {
              console.log('[wrapperr-net] XHR first chunk url:', url, '\nbody prefix:\n', txt.slice(0, 600));
            }
            post({ type: 'chunk', id, url, startedAt, body: txt });
          }
          if (this.readyState === 4) {
            if (started) {
              post({ type: 'end', id, url, startedAt, body: this.responseText || '' });
              if (window.__wrapperrDebug) console.log('[wrapperr-net] XHR end', url, 'bytes:', (this.responseText || '').length);
            }
          }
        } catch {}
      };

      try { this.addEventListener('readystatechange', onReady); } catch {}
      return origSend.apply(this, arguments);
    };
  }

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
