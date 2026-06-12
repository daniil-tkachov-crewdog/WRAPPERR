import type { AIModel } from './types';

// isExtensionActive: probes the global flag set by extension/content-scripts/wrapperr-flag.js
// when the extension is installed and enabled. SSR-safe (returns false on the server). Used by
// NoExtensionState to switch the chat surface into "install the extension" mode.
export function isExtensionActive(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as any).__WRAPPERR_EXTENSION_ACTIVE__ === true;
}

// Monotonic counter combined with Date.now() to mint per-call requestIds. Lives at module scope
// so concurrent in-flight sendMessageToAI/rereadFromAI calls never collide on the same id.
let requestCounter = 0;

// AIOptions — optional per-AI feature toggles forwarded to the content script. The shape mirrors
// AIOptionSlots in aiOptionsStorage.ts: each slot is an id from the matching pill in
// aiFeatures.ts (e.g. options.feature='web-search', options.intelligence='thinking'). Omitting
// any slot means "leave it alone" — applyOptions in the AI's content script defaults to the
// site's neutral state (no tool, default model). Adding this field is fully backwards-
// compatible: callers that don't pass options send exactly the payload they did before.
export type AIOptions = {
  feature?: string | string[];
  intelligence?: string;
  style?: string;
};

// sendMessageToAI: fire-and-await round-trip to the extension. Posts WRAPPERR_SEND to the page
// window (the bridge content script forwards it to the service worker), then listens for the
// matching WRAPPERR_RESPONSE keyed by requestId. Timeout default of 60s reflects worst-case AI
// streaming time on slow models; tune per caller. The listener is removed on resolve/reject so
// repeated calls don't leak event-listener references.
export function sendMessageToAI(
  ai: AIModel,
  message: string,
  timeoutMs: number = 60000,
  options?: AIOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = `req_${++requestCounter}_${Date.now()}`;
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Extension response timeout'));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      if (
        event.data?.type === 'WRAPPERR_RESPONSE' &&
        event.data?.requestId === requestId
      ) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.response as string);
        }
      }
    }

    window.addEventListener('message', handler);
    // options is included only when provided so legacy payloads stay byte-identical. The bridge
    // (extension/content-scripts/wrapperr-bridge.js) forwards event.data whole, so the SW
    // receives options without any bridge change.
    const payload: Record<string, unknown> = { type: 'WRAPPERR_SEND', requestId, ai, message };
    if (options) payload.options = options;
    window.postMessage(payload, '*');
  });
}

// rereadFromAI: ask the extension to re-scrape the latest assistant message from an AI's tab
// WITHOUT injecting a new prompt. Used by the Compare carousel's per-slide "recheck" button
// for cases where the original capture finished too early (e.g. only "Thinking…" came through).
// Shares the same WRAPPERR_RESPONSE return envelope as sendMessageToAI — the SW writes
// response/error keyed by requestId — so the listener pattern below mirrors sendMessageToAI.
export function rereadFromAI(
  ai: AIModel,
  timeoutMs: number = 30000
): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = `rer_${++requestCounter}_${Date.now()}`;
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Recheck timed out'));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      if (
        event.data?.type === 'WRAPPERR_RESPONSE' &&
        event.data?.requestId === requestId
      ) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.response as string);
        }
      }
    }

    window.addEventListener('message', handler);
    window.postMessage({ type: 'WRAPPERR_REREAD', requestId, ai }, '*');
  });
}
