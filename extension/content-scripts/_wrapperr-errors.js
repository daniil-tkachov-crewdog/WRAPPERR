// _wrapperr-errors.js — extension-side twin of web/lib/errors.ts.
//
// Loaded BEFORE every per-AI script (see AI_SCRIPTS injection in service-worker.js) so each
// content script can throw / return structured WrapperrErrors that survive the postMessage hops
// back to the web UI unchanged. The SW also reuses the registry — see the inline mirror in
// service-worker.js (kept as a copy because MV3 module SWs can't importScripts a plain script).
//
// IMPORTANT: keep the code list in sync with ERROR_REGISTRY in web/lib/errors.ts. Adding a code
// here without adding it there is fine (UI falls back to UNKNOWN with the raw cause shown), but
// adding a UI string to errors.ts without the JS twin defaults to UNKNOWN over the wire too.

(function () {
  if (window.__wrapperrErrorsLoaded) return;
  window.__wrapperrErrorsLoaded = true;

  // Registry — only the codes throwable from CONTENT SCRIPTS or surfaced via the SW need to
  // appear; auth/persistence codes live web-side only.
  const REG = {
    EXTENSION_NOT_ACTIVE:                        { scope: 'extension', stage: 'Detect Wrapperr extension',          message: 'Wrapperr extension is not active in this tab.' },
    BRIDGE_TIMEOUT:                              { scope: 'ai-flow',    stage: 'Wait for extension response',         message: 'Extension did not respond before the timeout.' },
    SW_TAB_OPEN:                                 { scope: 'extension', stage: 'Open / reuse the AI tab',             message: 'Could not open or reuse the target AI tab.' },
    SW_TAB_NAVIGATE:                             { scope: 'extension', stage: 'Navigate the AI tab',                 message: 'AI tab did not navigate to the expected URL.' },
    SW_SCRIPT_INJECT:                            { scope: 'extension', stage: 'Inject content scripts',              message: 'chrome.scripting.executeScript rejected.' },
    SW_SEND_INJECT:                              { scope: 'extension', stage: 'Hand prompt to content script',       message: 'Could not reach the content script in the AI tab.' },
    AI_APPLY_OPTIONS_TOOLS_TRIGGER_NOT_FOUND:    { scope: 'ai-flow',    stage: 'Open Tools popover on the AI site',  message: 'Could not find the Tools (Web Search / Deep Research) trigger.' },
    AI_APPLY_OPTIONS_TOOL_ROW_NOT_FOUND:         { scope: 'ai-flow',    stage: 'Pick a Tools row',                    message: 'Tools popover opened but the requested row was not found.' },
    AI_APPLY_OPTIONS_MODEL_TRIGGER_NOT_FOUND:    { scope: 'ai-flow',    stage: 'Open model picker',                   message: 'Could not find the model picker trigger.' },
    AI_APPLY_OPTIONS_MODEL_ROW_NOT_FOUND:        { scope: 'ai-flow',    stage: 'Pick a model',                        message: 'Model picker opened but the requested row was not found.' },
    AI_APPLY_OPTIONS_TIME_BUDGET:                { scope: 'ai-flow',    stage: 'Apply per-AI feature toggles',        message: 'applyOptions exceeded its 10-second time budget.' },
    AI_INJECT_INPUT_NOT_FOUND:                   { scope: 'ai-flow',    stage: 'Locate AI composer',                  message: 'Could not find the text input on the AI page.' },
    AI_INJECT_SUBMIT_FAILED:                     { scope: 'ai-flow',    stage: 'Submit the prompt',                   message: 'Pasted the prompt but could not send it.' },
    AI_POLL_HARD_TIMEOUT:                        { scope: 'ai-flow',    stage: 'Capture AI response',                 message: 'AI did not produce a stable response within the polling window.' },
    AI_POLL_ONLY_BASELINE:                       { scope: 'ai-flow',    stage: 'Capture AI response',                 message: 'Only the prior message / "Thinking…" was captured.' },
    WRAPPERR_TAB_MISSING:                        { scope: 'extension', stage: 'Forward response to Wrapperr',       message: 'Service worker had no Wrapperr tab to send the reply to.' },
    AI_REREAD_NO_TEXT:                           { scope: 'ai-flow',    stage: 'Re-read latest response',             message: 'No assistant text found on the AI tab.' },
    UNKNOWN:                                     { scope: 'unknown',    stage: 'Unknown failure',                     message: 'Something went wrong.' },
  };

  // wrapperrError(code, partial) — same shape as web/lib/errors.ts. The returned object is plain
  // JSON, so it survives every chrome.runtime.sendMessage / postMessage hop with no special
  // serialiser. `partial.details` is the right place to log the selectors you tried, response
  // status, etc. — the UI's Copy button dumps that block verbatim for paste-to-Claude.
  function wrapperrError(code, partial) {
    const base = REG[code] || REG.UNKNOWN;
    const p = partial || {};
    return {
      code: code,
      at: Date.now(),
      scope: base.scope,
      stage: base.stage,
      message: base.message,
      hint: p.hint,
      details: p.details,
      cause: p.cause,
      ai: p.ai,
      requestId: p.requestId,
    };
  }

  // toWrapperrError(err) — normalise any value (caught Error, string, object) into the wire
  // shape. Idempotent. Use at every catch boundary inside the extension.
  function toWrapperrError(err, fallbackCode, partial) {
    if (err && typeof err === 'object' && err.code && err.stage && err.scope) return err;
    const p = partial || {};
    const code = fallbackCode || 'UNKNOWN';
    if (err && err.message) {
      return wrapperrError(code, Object.assign({}, p, {
        cause: { name: err.name, message: err.message, stack: err.stack },
      }));
    }
    return wrapperrError(code, Object.assign({}, p, {
      cause: { message: typeof err === 'string' ? err : JSON.stringify(err) },
    }));
  }

  window.wrapperrError = wrapperrError;
  window.toWrapperrError = toWrapperrError;
  window.WRAPPERR_ERROR_REGISTRY = REG;
})();
