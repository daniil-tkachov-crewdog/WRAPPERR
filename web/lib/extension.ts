import type { AIModel } from './types';
import { wrapperrError, toWrapperrError, WrapperrErrorObject, type WrapperrError } from './errors';

// extension.ts — the only place the web app talks to the extension over postMessage.
//
// Error contract (since the "every-error visible" overhaul):
//   - sendMessageToAI / rereadFromAI reject with a WrapperrErrorObject (Error subclass with a
//     .wrapperr WrapperrError field). Callers can `toWrapperrError(err)` to recover the shape,
//     or just attach `err.wrapperr` to the rendered message.
//   - The bridge envelope (WRAPPERR_RESPONSE.error) may now be either a WrapperrError object
//     (current SW + content scripts) or a plain string (legacy paths during the migration).
//     parseBridgeError() handles both shapes — never assume a string OR an object on this hop.

export function isExtensionActive(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as any).__WRAPPERR_EXTENSION_ACTIVE__ === true;
}

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

// parseBridgeError — accept either a WrapperrError object or a legacy string; always return a
// WrapperrError. Tags the requestId / ai on the way through so the Copy block has provenance.
function parseBridgeError(raw: unknown, ai: AIModel, requestId: string): WrapperrError {
  if (raw && typeof raw === 'object' && (raw as WrapperrError).code) {
    return { ...(raw as WrapperrError), ai: ai, requestId };
  }
  if (typeof raw === 'string') {
    return wrapperrError('UNKNOWN', { ai, requestId, cause: { message: raw } });
  }
  return toWrapperrError(raw, 'UNKNOWN', { ai, requestId });
}

export function sendMessageToAI(
  ai: AIModel,
  message: string,
  timeoutMs: number = 60000,
  options?: AIOptions
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Pre-flight: if the extension's MAIN-world flag is missing, we can short-circuit with a
    // crystal-clear EXTENSION_NOT_ACTIVE rather than waiting for a timeout. This is the most
    // common failure mode for a new user, so the UI shouldn't make them wait timeoutMs to learn.
    if (!isExtensionActive()) {
      reject(new WrapperrErrorObject(wrapperrError('EXTENSION_NOT_ACTIVE', { ai })));
      return;
    }

    const requestId = `req_${++requestCounter}_${Date.now()}`;
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new WrapperrErrorObject(wrapperrError('BRIDGE_TIMEOUT', {
        ai, requestId, details: { timeoutMs },
      })));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      if (
        event.data?.type === 'WRAPPERR_RESPONSE' &&
        event.data?.requestId === requestId
      ) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new WrapperrErrorObject(parseBridgeError(event.data.error, ai, requestId)));
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
    if (!isExtensionActive()) {
      reject(new WrapperrErrorObject(wrapperrError('EXTENSION_NOT_ACTIVE', { ai })));
      return;
    }

    const requestId = `rer_${++requestCounter}_${Date.now()}`;
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new WrapperrErrorObject(wrapperrError('BRIDGE_TIMEOUT', {
        ai, requestId, details: { timeoutMs, op: 'reread' },
      })));
    }, timeoutMs);

    function handler(event: MessageEvent) {
      if (
        event.data?.type === 'WRAPPERR_RESPONSE' &&
        event.data?.requestId === requestId
      ) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new WrapperrErrorObject(parseBridgeError(event.data.error, ai, requestId)));
        } else {
          resolve(event.data.response as string);
        }
      }
    }

    window.addEventListener('message', handler);
    window.postMessage({ type: 'WRAPPERR_REREAD', requestId, ai }, '*');
  });
}
