// MAIN-world fetch hook. Runs at document_start before any AI site script executes, so we
// can wrap window.fetch BEFORE the page captures a reference. Mission: capture streaming
// response bodies straight from the network layer, bypassing the rAF-paused UI in background
// tabs. Critical: tee the body so the page's own consumer still receives the data unchanged
// (its UI works as normal when focused), while a parallel reader buffers the same bytes for us.
//
// Output: posts {source: 'wrapperr-net', type, id, url, ...} window.postMessage events to the
// isolated world. The shared content-script helper picks these up and races them against the
// MutationObserver-based DOM scrape; whichever produces text first wins.
//
// Caveats:
//   - We only intercept POSTs (chat completion endpoints are POSTs). Saves overhead on every GET.
//   - We only tee responses that look streamy (text/event-stream / unspecified content-type
//     / NDJSON). Non-streaming responses pass through unchanged with zero overhead.
//   - We do NOT intercept XMLHttpRequest. All current AI sites use fetch for streaming.
//   - Each invocation guards via window.__wrapperrFetchHooked so document_start re-injection
//     (e.g., after SPA route changes) doesn't double-wrap fetch.
(() => {
  if (window.__wrapperrFetchHooked) return;
  window.__wrapperrFetchHooked = true;

  const STREAMY_CT = ['text/event-stream', 'application/x-ndjson', 'application/jsonl'];
  let counter = 0;

  function looksStreamy(response) {
    const ct = (response.headers.get('content-type') || '').toLowerCase();
    if (!ct) return true; // unspecified — many AI APIs do this
    return STREAMY_CT.some((t) => ct.includes(t));
  }

  function post(payload) {
    try {
      window.postMessage(Object.assign({ source: 'wrapperr-net' }, payload), window.location.origin);
    } catch {}
  }

  const origFetch = window.fetch.bind(window);
  window.fetch = async function wrapperrPatchedFetch(input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

    if (method !== 'POST') {
      return origFetch(input, init);
    }

    let response;
    try {
      response = await origFetch(input, init);
    } catch (e) {
      throw e;
    }

    if (!response.body || !looksStreamy(response)) {
      return response;
    }

    const id = ++counter;
    const startedAt = Date.now();
    post({ type: 'start', id, url, startedAt });

    let teed;
    try {
      teed = response.body.tee();
    } catch {
      // tee() can throw if the body has already been consumed. Skip interception in that case.
      return response;
    }
    const [forPage, forUs] = teed;

    (async () => {
      const reader = forUs.getReader();
      const decoder = new TextDecoder();
      let body = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            const tail = decoder.decode();
            if (tail) body += tail;
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          body += chunk;
        }
        post({ type: 'end', id, url, startedAt, body });
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
  // ChatGPT (and increasingly other AIs) returns a conduit JWT from the chat POST and then
  // streams the actual reply over a WebSocket connection. The fetch hook above only sees the
  // JWT response; the message text is in the WS frames. We Proxy window.WebSocket so
  // instanceof and most introspection still work, listen to incoming string frames, accumulate
  // them, and dispatch a streamComplete-style event after a short debounce of silence (real
  // chat responses always end with a quiet period before the next message). Only string frames
  // are accumulated — binary frames are skipped because the parser is text-only.
  const origWebSocket = window.WebSocket;
  if (origWebSocket && !window.__wrapperrWSHooked) {
    window.__wrapperrWSHooked = true;
    const SILENCE_DEBOUNCE_MS = 1500;

    window.WebSocket = new Proxy(origWebSocket, {
      construct(target, args) {
        const ws = Reflect.construct(target, args);
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.toString?.() || '');
        if (!url || (!url.startsWith('wss://') && !url.startsWith('ws://'))) return ws;

        const id = ++counter;
        const startedAt = Date.now();
        let body = '';
        let endTimer = null;
        let endedFlag = false;

        function flushEnd() {
          if (endedFlag) return;
          endedFlag = true;
          if (endTimer) { clearTimeout(endTimer); endTimer = null; }
          post({ type: 'end', id, url, startedAt, body });
        }

        post({ type: 'start', id, url, startedAt });

        try {
          ws.addEventListener('message', (event) => {
            // Only accumulate string frames; binary (Blob/ArrayBuffer) is rare for AI streaming.
            if (typeof event.data !== 'string' || !event.data) return;
            // Append a separator newline so SSE-style block parsing works on accumulated frames.
            body += event.data + '\n\n';
            if (endTimer) clearTimeout(endTimer);
            endTimer = setTimeout(flushEnd, SILENCE_DEBOUNCE_MS);
          });
          ws.addEventListener('close', flushEnd);
          ws.addEventListener('error', flushEnd);
        } catch {
          // If the AI site blocks event listener attachment for any reason, swallow — the page
          // still functions normally; we just don't capture this WS.
        }

        return ws;
      },
    });
  }
})();
