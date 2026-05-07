// Shared response-completion helper used by all AI content scripts.
// Why MutationObserver: Chrome throttles setTimeout/setInterval aggressively in any non-focused
// tab. Wrapperr always keeps the user on its own tab, so the AI tab is always non-focused and
// pure-polling-based detection misses streaming-end transitions (response either times out or
// arrives much later when the user manually focuses the tab). MutationObservers fire on actual
// DOM mutations regardless of tab focus.
//
// Algorithm:
//   1. Snapshot initialCount of response containers — gates against capturing a prior reply.
//   2. Observe document.body for childList/subtree/characterData/attributes mutations.
//   3. On each mutation, re-evaluate: capture latest text, check streaming flag, track the
//      streaming on→off transition (positive done-signal).
//   4. Each evaluation arms a single trailing setTimeout: SHORT_STABLE_MS (~1.5s) if we've
//      seen the streaming end, LONG_STABLE_MS (~6.4s) otherwise. Each new mutation cancels and
//      reschedules — so the timer only fires when mutations have stopped for the full window.
//   5. The trailing setTimeout itself can be throttled in background tabs (Chrome's minimum
//      ~1s clamp), but worst case is a slightly delayed resolve, never a missed response.
//   6. Hard timeout (240s) is a safety net only.
function wrapperrWaitForResponse(opts) {
  const { responseSelector, getStreaming } = opts;

  const initialCount = document.querySelectorAll(responseSelector).length;

  return new Promise((resolve) => {
    const HARD_TIMEOUT_MS = 240000;
    const SHORT_STABLE_MS = 1500;
    const LONG_STABLE_MS = 6400;

    let lastText = '';
    let sawStreamingEnd = false;
    let prevStreaming = false;
    let resolved = false;
    let stableTimer = null;
    let observer = null;

    function evaluate() {
      if (resolved) return;

      const messages = document.querySelectorAll(responseSelector);
      if (messages.length <= initialCount) return;

      const last = messages[messages.length - 1];
      const innerText = last?.innerText?.trim() ?? '';
      const textContent = last?.textContent?.trim() ?? '';
      const text = textContent.length > innerText.length ? textContent : innerText;

      const streaming = !!getStreaming(last);
      if (prevStreaming && !streaming) sawStreamingEnd = true;
      prevStreaming = streaming;

      if (text !== lastText) lastText = text;

      if (stableTimer) clearTimeout(stableTimer);
      if (lastText && !streaming) {
        const win = sawStreamingEnd ? SHORT_STABLE_MS : LONG_STABLE_MS;
        stableTimer = setTimeout(() => {
          if (resolved) return;
          // Defensive recheck — late attribute mutations could flip streaming back on between
          // arming and firing, especially in throttled tabs.
          if (!getStreaming(last)) finish(lastText);
        }, win);
      }
    }

    function finish(text) {
      resolved = true;
      if (observer) observer.disconnect();
      if (stableTimer) clearTimeout(stableTimer);
      resolve(text);
    }

    observer = new MutationObserver(evaluate);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    });

    setTimeout(() => {
      if (!resolved) finish(lastText || 'No response received.');
    }, HARD_TIMEOUT_MS);

    // Initial evaluate — handles the case where the response was already complete before we
    // started observing (cached reply, instant response).
    evaluate();
  });
}
