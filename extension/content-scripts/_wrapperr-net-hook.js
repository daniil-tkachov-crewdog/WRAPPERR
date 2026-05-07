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
})();
