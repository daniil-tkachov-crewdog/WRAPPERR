// errors.ts — Wrapperr's single source of truth for structured errors.
//
// Goal: every failure point across the web app, the extension SW, and per-AI content scripts
// produces a WrapperrError that the UI can show with (a) a human one-liner, (b) a HINT that
// points the developer at the right file/selector, (c) a Copy-details block ready to paste to
// Claude or a dev. No more "Something went wrong: <stringified message>".
//
// Three pieces:
//   1. WrapperrError       — the carrier shape, transport-friendly (plain JSON).
//   2. ERROR_REGISTRY      — code → default stage / message / hint / scope. Adding a code here
//                            is the one-touch way to give a new failure point UI semantics.
//   3. wrapperrError() / toWrapperrError() / runStage() — builders + normaliser.
//
// Back-compat: any legacy thrown Error or string still becomes a WrapperrError via
// toWrapperrError(), tagged code='UNKNOWN'. Nothing breaks while we migrate call-by-call.

export type WrapperrErrorScope =
  | 'ai-flow'       // user prompt → AI tab → captured reply
  | 'auth'          // Supabase sign-in / sign-up / reset / callback
  | 'persistence'   // chat upsert, profile load, etc.
  | 'extension'     // bridge / SW / tab plumbing (not the AI step itself)
  | 'settings'      // settings page reads / writes
  | 'unknown';

// WrapperrError — the wire shape. Kept JSON-friendly so it survives every transport hop:
// content script → chrome.tabs.sendMessage → SW → chrome.tabs.sendMessage → bridge →
// window.postMessage → web app.
export interface WrapperrError {
  code: string;
  stage: string;
  scope: WrapperrErrorScope;
  message: string;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: { name?: string; message?: string; stack?: string };
  ai?: string;
  requestId?: string;
  at: number;
}

// Registry — the only place a new error code needs to land. UI strings live here so a typo
// fix is a one-line PR; details/hint can still be enriched at the throw site via the
// `partial` arg to wrapperrError().
type RegistryEntry = Omit<WrapperrError, 'code' | 'at' | 'details' | 'cause' | 'ai' | 'requestId'>;

export const ERROR_REGISTRY: Record<string, RegistryEntry> = {
  // ── AI messaging flow ────────────────────────────────────────────────────────────────────
  EXTENSION_NOT_ACTIVE: {
    scope: 'extension',
    stage: 'Detect Wrapperr extension',
    message: 'Wrapperr extension is not active in this tab.',
    hint: 'Install/enable the Wrapperr extension and reload this page. Make sure the page URL matches the host_permissions in extension/manifest.json.',
  },
  BRIDGE_TIMEOUT: {
    scope: 'ai-flow',
    stage: 'Wait for extension response',
    message: 'Extension did not respond before the timeout.',
    hint: 'Either the AI tab never produced a stable reply, or the service worker died mid-request. Try again; if it persists, raise the Timeout pill in the chat bar or inspect chrome://extensions service-worker logs.',
  },
  SW_TAB_OPEN: {
    scope: 'extension',
    stage: 'Open / reuse the AI tab',
    message: 'Could not open or reuse the target AI tab.',
    hint: 'Service worker tab plumbing failed (ensureTab in extension/background/service-worker.js). Could be a closed tab race, a discarded tab Chrome refused to reload, or the AI URL changed.',
  },
  SW_TAB_NAVIGATE: {
    scope: 'extension',
    stage: 'Navigate the AI tab',
    message: 'AI tab did not navigate to the expected URL.',
    hint: 'AI_URLS in service-worker.js may be stale (the provider moved domains), or the page blocked the navigation.',
  },
  SW_SCRIPT_INJECT: {
    scope: 'extension',
    stage: 'Inject content scripts',
    message: 'chrome.scripting.executeScript rejected.',
    hint: 'Usually a host_permissions miss in manifest.json or a CSP block on the AI page. Check the manifest matches and Chrome devtools console for CSP violations.',
  },
  SW_SEND_INJECT: {
    scope: 'extension',
    stage: 'Hand prompt to content script',
    message: 'Could not reach the content script in the AI tab.',
    hint: '"Receiving end does not exist" usually means the content script crashed on load or the tab was closed mid-flight. Reload the AI tab; check that tab\'s devtools console.',
  },
  AI_APPLY_OPTIONS_TOOLS_TRIGGER_NOT_FOUND: {
    scope: 'ai-flow',
    stage: 'Open Tools popover on the AI site',
    message: 'Could not find the Tools (Web Search / Deep Research) trigger.',
    hint: 'The provider changed their composer DOM. Update the three findToolsTrigger() strategies in the matching content-scripts/<ai>.js file.',
  },
  AI_APPLY_OPTIONS_TOOL_ROW_NOT_FOUND: {
    scope: 'ai-flow',
    stage: 'Pick a Tools row',
    message: 'Tools popover opened but the requested row was not found.',
    hint: 'The label text or the menu-item role changed. Update findToolRow() in the matching content-scripts/<ai>.js file.',
  },
  AI_APPLY_OPTIONS_MODEL_TRIGGER_NOT_FOUND: {
    scope: 'ai-flow',
    stage: 'Open model picker',
    message: 'Could not find the model picker trigger.',
    hint: 'Provider redesigned the composer pill. Update findModelPickerTrigger() / KNOWN_MODEL_LABELS in content-scripts/<ai>.js.',
  },
  AI_APPLY_OPTIONS_MODEL_ROW_NOT_FOUND: {
    scope: 'ai-flow',
    stage: 'Pick a model',
    message: 'Model picker opened but the requested row was not found.',
    hint: 'Provider renamed the model row testid / role. Update findModelMenuItem() in content-scripts/<ai>.js.',
  },
  AI_APPLY_OPTIONS_TIME_BUDGET: {
    scope: 'ai-flow',
    stage: 'Apply per-AI feature toggles',
    message: 'applyOptions exceeded its 10-second time budget.',
    hint: 'The AI page was probably loading. Try again in a few seconds, or open the AI tab manually once to warm it up.',
  },
  AI_INJECT_INPUT_NOT_FOUND: {
    scope: 'ai-flow',
    stage: 'Locate AI composer',
    message: 'Could not find the text input on the AI page.',
    hint: 'The provider changed their composer. Update the input selector list in content-scripts/<ai>.js::injectMessage().',
  },
  AI_INJECT_SUBMIT_FAILED: {
    scope: 'ai-flow',
    stage: 'Submit the prompt',
    message: 'Pasted the prompt but could not send it.',
    hint: 'The Send button might be hidden behind a disabled state (composer think tools may have re-disabled it) or its selector changed. Inspect the button on the AI page; update the selector chain in content-scripts/<ai>.js::injectMessage().',
  },
  AI_POLL_HARD_TIMEOUT: {
    scope: 'ai-flow',
    stage: 'Capture AI response',
    message: 'AI did not produce a stable response within the polling window.',
    hint: 'Either the AI is still streaming and slow, or capture is missing the response. Try the "Re-check" button (in Compare) or increase Timeout in the chat bar.',
  },
  AI_POLL_ONLY_BASELINE: {
    scope: 'ai-flow',
    stage: 'Capture AI response',
    message: 'Only the prior message / "Thinking…" was captured.',
    hint: 'The capture pipeline polled before the new reply arrived. Open the AI tab and re-check; if the answer is there, content-scripts/providers/<ai>-parser.js may need tuning.',
  },
  WRAPPERR_TAB_MISSING: {
    scope: 'extension',
    stage: 'Forward response to Wrapperr',
    message: 'Service worker had no Wrapperr tab to send the reply to.',
    hint: 'The Wrapperr web tab was closed while a request was in flight. Re-open the tab and resend.',
  },
  AI_REREAD_NO_TEXT: {
    scope: 'ai-flow',
    stage: 'Re-read latest response',
    message: 'No assistant text found on the AI tab.',
    hint: 'The tab may have been navigated, or the assistant DOM root changed. Inspect the tab; update RESPONSE_SELECTOR in content-scripts/<ai>.js.',
  },

  // ── Auth (Supabase) ──────────────────────────────────────────────────────────────────────
  AUTH_SIGN_IN: {
    scope: 'auth',
    stage: 'Sign in',
    message: 'Supabase sign-in rejected the credentials.',
    hint: 'Check that the account exists and has a password. Magic-link accounts need "Forgot password?" first.',
  },
  AUTH_SIGN_UP: {
    scope: 'auth',
    stage: 'Sign up',
    message: 'Supabase sign-up failed.',
    hint: 'Could be duplicate email, weak password (Supabase enforces a minimum length), or the project\'s sign-ups are disabled.',
  },
  AUTH_MAGIC_LINK: {
    scope: 'auth',
    stage: 'Send magic link',
    message: 'Supabase magic-link request failed.',
    hint: 'Email rate-limited, or SMTP not configured in the Supabase project.',
  },
  AUTH_RESET: {
    scope: 'auth',
    stage: 'Send password reset',
    message: 'Supabase password-reset request failed.',
    hint: 'Email rate-limited, or the redirectTo URL is not on the Supabase project\'s allow-list.',
  },

  // ── Persistence (Supabase chats / profiles) ──────────────────────────────────────────────
  PERSISTENCE_SAVE_CHAT: {
    scope: 'persistence',
    stage: 'Save chat',
    message: 'Supabase rejected the chat upsert.',
    hint: 'Likely an RLS policy mismatch on the chats table or a schema drift. Check supabase/schema.sql and the chats RLS in the dashboard.',
  },

  // ── Catch-all ────────────────────────────────────────────────────────────────────────────
  UNKNOWN: {
    scope: 'unknown',
    stage: 'Unknown failure',
    message: 'Something went wrong.',
    hint: 'No registered code matched this error. The raw cause is below — paste the Copy block to Claude/dev to diagnose.',
  },
};

// wrapperrError — factory. Looks up the registry, then overlays `partial` (which can add
// details/cause/hint/ai/requestId or override the default stage/message). Always stamps `at`.
export function wrapperrError(
  code: string,
  partial: Partial<Omit<WrapperrError, 'code' | 'at'>> = {}
): WrapperrError {
  const base = ERROR_REGISTRY[code] ?? ERROR_REGISTRY.UNKNOWN;
  return {
    code,
    at: Date.now(),
    scope: base.scope,
    stage: base.stage,
    message: base.message,
    hint: base.hint,
    ...partial,
  };
}

// toWrapperrError — normalise any thrown value into a WrapperrError. Idempotent: an object
// already shaped like a WrapperrError passes through. A plain Error or string becomes UNKNOWN
// with its message captured as `cause`. This is the boundary every catch should call.
export function toWrapperrError(
  err: unknown,
  fallbackCode: string = 'UNKNOWN',
  partial: Partial<Omit<WrapperrError, 'code' | 'at'>> = {}
): WrapperrError {
  if (err && typeof err === 'object' && 'code' in err && 'stage' in err && 'scope' in err) {
    return err as WrapperrError;
  }
  // WrapperrErrorObject (Error subclass) carries the WrapperrError on .wrapperr — pluck it.
  if (err && typeof err === 'object' && 'wrapperr' in err) {
    const w = (err as { wrapperr: unknown }).wrapperr;
    if (w && typeof w === 'object' && 'code' in w) return w as WrapperrError;
  }
  if (err instanceof Error) {
    return wrapperrError(fallbackCode, {
      cause: { name: err.name, message: err.message, stack: err.stack },
      ...partial,
    });
  }
  return wrapperrError(fallbackCode, {
    cause: { message: typeof err === 'string' ? err : JSON.stringify(err) },
    ...partial,
  });
}

// WrapperrErrorObject — Error subclass that carries a WrapperrError, so async code can
// `throw new WrapperrErrorObject(wrapperrError('AUTH_SIGN_IN', { cause: ... }))` and the catch
// downstream can `if (err instanceof WrapperrErrorObject) {...}` or just call toWrapperrError(err).
export class WrapperrErrorObject extends Error {
  wrapperr: WrapperrError;
  constructor(w: WrapperrError) {
    super(`${w.stage}: ${w.message}`);
    this.name = 'WrapperrError';
    this.wrapperr = w;
  }
}

// runStage — thin wrapper: run `fn`; on throw, wrap as WrapperrError with `code` and re-throw
// as WrapperrErrorObject. Used at every boundary call (Supabase, fetch, postMessage helper).
// Lets call sites stay readable without a sprawl of try/catch.
export async function runStage<T>(
  code: string,
  fn: () => Promise<T>,
  enrich?: Partial<Omit<WrapperrError, 'code' | 'at'>>
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const w = toWrapperrError(err, code, enrich);
    // Preserve the original code when toWrapperrError already chose one (e.g. nested runStage).
    if (w.code === 'UNKNOWN' && code !== 'UNKNOWN') w.code = code;
    throw new WrapperrErrorObject({ ...w, code: w.code === 'UNKNOWN' ? code : w.code });
  }
}

// formatForCopy — the paste-to-Claude block. Compact JSON with headline lines on top so
// even a quick read shows code + stage + message. Used by the Copy button in ErrorBubble /
// ErrorBanner.
export function formatForCopy(w: WrapperrError): string {
  const lines = [
    'WRAPPERR ERROR',
    `code:    ${w.code}`,
    `stage:   ${w.stage}`,
    `scope:   ${w.scope}`,
    w.ai ? `ai:      ${w.ai}` : null,
    `message: ${w.message}`,
    w.hint ? `hint:    ${w.hint}` : null,
    w.requestId ? `request: ${w.requestId}` : null,
    `at:      ${new Date(w.at).toISOString()}`,
    '',
    'details:',
    JSON.stringify(w.details ?? {}, null, 2),
    '',
    'cause:',
    JSON.stringify(w.cause ?? {}, null, 2),
  ].filter(Boolean);
  return lines.join('\n');
}
