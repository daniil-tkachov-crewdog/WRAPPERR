// Load guard: chrome.scripting.executeScript re-runs this file every time the SW calls
// sendToAI. Top-level `const` (RESPONSE_SELECTOR, TOOL_LABEL, KNOWN_MODEL_LABELS) throws
// SyntaxError on re-declaration — caught by the SW's try/catch, harmless functionally, but
// noisy in the chatgpt.com console. Wrapping the whole file in a one-time guard makes the
// second injection a clean no-op. The first injection's chrome.runtime listener stays live
// and handles every subsequent send.
if (!window.__wrapperrChatGPTLoaded) {
  window.__wrapperrChatGPTLoaded = true;

// injectMessage: locate ChatGPT's composer (textarea OR contenteditable) and submit.
//
// All actual typing logic lives in _wrapperr-input.js. The input module auto-selects the right
// strategy based on the element type — textarea uses the React-prototype-setter route, the
// newer contenteditable composer falls through to the synthetic-paste route.
async function injectMessage(message) {
  const input = document.querySelector('#prompt-textarea')
    ?? document.querySelector('textarea[data-id="root"]')
    ?? document.querySelector('div[contenteditable="true"]');
  if (!input) throw new Error('ChatGPT input not found');

  await wrapperrInjectInput(input, { kind: 'text', text: message });

  const sendBtn = document.querySelector('[data-testid="send-button"]')
    ?? document.querySelector('button[aria-label="Send prompt"]')
    ?? document.querySelector('button[data-testid="fruitjuice-send-button"]')
    ?? document.querySelector('button[class*="send"]');

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// AI-specific selector for assistant message bubbles. Used both for baseline counting (so we
// don't return prior responses) and for DOM-scrape fallback when network capture yields nothing.
const RESPONSE_SELECTOR = '[data-message-author-role="assistant"]';

// Stream parser + buffer reader live in providers/chatgpt-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and expose
// the global readBestChatGPTText() used below.

// getBaseline: snapshot the assistant-message count + last text BEFORE injection, so the SW can
// distinguish the new response from any prior one.
function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// getCurrentState: synchronous read of the current best-known response text. Tries the network
// capture first (works in background tabs because WS frames fire onmessage handlers regardless
// of focus); falls back to DOM scraping when the parser yields nothing. Returns '' when neither
// path has produced a response distinct from the baseline yet.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestChatGPTText(sentAt);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

// readLatestResponse: synchronous best-effort read of the LAST assistant message, used by the
// Compare carousel's "recheck" button when the original capture finished early. No baseline,
// no grace gate — we want whatever is in the buffer or DOM right now. Network buffer is
// preferred because ChatGPT's DOM renders markdown as HTML (loses fence ticks, list symbols).
// Passing sentAt=0 to the parser returns the longest captured stream regardless of age.
function readLatestResponse() {
  const netText = readBestChatGPTText(0);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const last = messages[messages.length - 1];
  return last ? wrapperrBestText(last) : '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// radixOpen: ChatGPT's Tools popover and model picker are built with Radix UI's DropdownMenu,
// which subscribes to `pointerdown` (mouse path) — a synthetic `.click()` fires `click` but
// skips pointerdown, so Radix never sees an "open" intent. We dispatch the full pointer →
// mouse → click sequence at the element's centre point. Send/menu-item clicks are NOT Radix
// triggers (they're plain buttons or list items), so they still use `.click()` and we keep it
// that way to avoid double-firing handlers there.
function radixOpen(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
  const down = { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1 };
  const up   = { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', down));
  el.dispatchEvent(new MouseEvent('mousedown',   { ...base, button: 0, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup',   up));
  el.dispatchEvent(new MouseEvent('mouseup',     { ...base, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click',       { ...base, button: 0, buttons: 0 }));
}

// applyOptions: best-effort apply per-AI feature toggles (Web Search, Deep Research, Thinking
// model) BEFORE injecting the prompt. options shape: { feature?: string | string[],
// intelligence?: string, style?: string }. The set of ids comes from web/lib/aiFeatures.ts.
//
// Hard contract: applyOptions MUST NOT throw. Each action runs inside its own try/catch and a
// failure here logs a warning then falls through to injection — better to send the prompt
// without a toggle than to abort entirely. Internal time budget: ~5s per action, ~10s total.
// The user-set timeoutMs covers the whole round-trip via extension.ts, so a slow applyOptions
// just eats some of the user's reply budget — it doesn't add a separate timeout.
async function applyOptions(options) {
  if (!options || typeof options !== 'object') return;
  const hasAny = options.feature !== undefined || options.intelligence !== undefined || options.style !== undefined;
  if (!hasAny) return;

  const TOTAL_BUDGET_MS = 10000;
  const PER_ACTION_MS = 5000;
  const start = Date.now();
  const remaining = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - start));

  // Tools (feature slot) — Web Search / Deep Research / none. Always run, even when feature is
  // undefined, so we can ensure tools are OFF when the user has explicitly cleared the pill.
  try {
    if (remaining() > 0) {
      await withTimeout(applyToolsFeature(options.feature), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] ChatGPT applyToolsFeature failed:', err && err.message || err);
  }

  // Model (intelligence slot) — Instant / Thinking. Skip silently when undefined (means "leave
  // the model alone"). For known values we still run even if we believe the current state
  // matches — getCurrentModelLabel reads cheaply from the trigger button.
  try {
    if (options.intelligence !== undefined && remaining() > 0) {
      await withTimeout(applyModelIntelligence(options.intelligence), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] ChatGPT applyModelIntelligence failed:', err && err.message || err);
  }
}

// withTimeout: race a promise against a timer. Used to enforce the per-action budget without
// dragging in AbortController plumbing through every helper. The timer rejection still allows
// the caller's try/catch to swallow and proceed to injection.
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`applyOptions step timed out after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// waitFor: poll a predicate every 50ms up to maxMs, resolving with its truthy value or null on
// timeout. Used everywhere we expect a DOM change (menu opens, item appears, trigger updates).
async function waitFor(predicate, maxMs = 1500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const v = predicate();
      if (v) return v;
    } catch { /* keep polling */ }
    await sleep(50);
  }
  return null;
}

// ─── Tools popover (Web Search / Deep Research) ──────────────────────────────────────────────
//
// Captured DOM from chatgpt.com on a logged-in Plus account (fresh chat):
//   • Trigger: <button id="composer-plus-btn" data-testid="composer-plus-btn"
//              aria-label="Add files and more" aria-haspopup="menu" aria-expanded="…"
//              data-state="open|closed" aria-controls="radix-_R_…">
//   • Each tool row: <div role="menuitemradio" aria-checked="true|false"
//                    data-state="checked|unchecked" class="group __menu-item">
//     containing an inner text span with the label ("Web search", "Deep research", "Create
//     image"). Radio semantics: clicking an unchecked row checks it AND auto-unchecks any
//     siblings (ChatGPT enforces single-tool-at-a-time today). Clicking a checked row toggles
//     it off.
//
// Three ranked strategies for the Tools trigger (best → worst). The helper falls through to the
// next strategy when the prior returns null:
//   1. [data-testid="composer-plus-btn"]              — the most stable identifier; testids are
//                                                       maintained by OpenAI for their own E2E
//                                                       tests, so they outlive class renames.
//   2. #composer-plus-btn                             — explicit id; same element, different
//                                                       hook. Falls through if testid is dropped.
//   3. button[aria-haspopup="menu"][aria-label*="Add files"] — semantic fallback by accessible
//                                                       label; survives a wholesale class /
//                                                       testid revamp.
function findToolsTrigger() {
  return document.querySelector('[data-testid="composer-plus-btn"]')
      ?? document.querySelector('#composer-plus-btn')
      ?? document.querySelector('button[aria-haspopup="menu"][aria-label*="Add files" i]');
}

// Three ranked strategies for finding one tool row inside the open popover. `label` is matched
// case-insensitively against the row's trimmed text. ChatGPT labels them "Web search" and
// "Deep research" (lowercase second word) — we match by includes() to survive sentence-case
// changes:
//   1. [role="menuitemradio"] whose text matches               — strongest; matches the exact
//                                                                Radix role used by the rows.
//   2. [role="menuitem"] whose text matches                    — fallback if OpenAI drops radio
//                                                                semantics (e.g. converts to a
//                                                                multi-select checkbox group).
//   3. [data-radix-collection-item] whose text matches         — broadest; Radix tags every
//                                                                collection item, so this hits
//                                                                even after role changes.
function findToolRow(label) {
  const want = label.toLowerCase();
  function matchByRole(role) {
    const rows = document.querySelectorAll(`[role="${role}"]`);
    for (const r of rows) {
      const t = (r.textContent || '').trim().toLowerCase();
      if (t.includes(want)) return r;
    }
    return null;
  }
  return matchByRole('menuitemradio')
      ?? matchByRole('menuitem')
      ?? (() => {
        const rows = document.querySelectorAll('[data-radix-collection-item]');
        for (const r of rows) {
          const t = (r.textContent || '').trim().toLowerCase();
          if (t.includes(want)) return r;
        }
        return null;
      })();
}

// isToolRowOn: read the radio state of a row. Prefers aria-checked (accessibility-grade
// stable), falls back to data-state.
function isToolRowOn(row) {
  if (!row) return false;
  const aria = row.getAttribute('aria-checked');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  const ds = row.getAttribute('data-state');
  return ds === 'checked' || ds === 'on';
}

// openToolsPopover: clicks the trigger and waits for aria-expanded=true. Idempotent if already
// open. Returns true on success, false on failure (trigger missing or popover never opens).
async function openToolsPopover() {
  const trigger = findToolsTrigger();
  if (!trigger) return false;
  if (trigger.getAttribute('aria-expanded') === 'true') return true;
  radixOpen(trigger);
  const ok = await waitFor(() => trigger.getAttribute('aria-expanded') === 'true', 1500);
  return Boolean(ok);
}

// closeToolsPopover: prefer clicking the trigger again (which Radix treats as toggle); fall
// back to Escape if the trigger is missing or the click didn't take. Waits for aria-expanded
// to flip back to false so a subsequent send-button click can't accidentally land in the menu.
async function closeToolsPopover() {
  // Prefer Escape — pointer-events on the trigger when the menu is open can re-trigger Radix's
  // open intent on some versions. Escape always closes the topmost dropdown cleanly.
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  const closed = await waitFor(() => {
    const t = findToolsTrigger();
    return !t || t.getAttribute('aria-expanded') !== 'true';
  }, 500);
  if (closed) return;
  // Escape ignored? Try clicking the trigger as a fallback toggle.
  const trigger = findToolsTrigger();
  if (trigger && trigger.getAttribute('aria-expanded') === 'true') {
    radixOpen(trigger);
    await waitFor(() => trigger.getAttribute('aria-expanded') !== 'true', 500);
  }
}

// Map our internal feature ids to ChatGPT's row labels. 'create-image' is `comingSoon: true` in
// aiFeatures.ts so the UI won't send it, but we defend anyway by treating it as "no tool".
const TOOL_LABEL = {
  'web-search':    'web search',
  'deep-research': 'deep research',
};

// applyToolsFeature: set the Tools state to match the requested feature id (or clear all tools
// when feature is undefined / unknown / a soon-only id like 'create-image'). The flow:
//   1. Open the popover.
//   2. Identify the currently-checked row (if any) and the desired row (if any).
//   3. If desired === current → close popover, done (fast path).
//   4. Otherwise click the desired row (which auto-unchecks the current one) OR click the
//      currently-on row to turn it off (when desired is "no tool").
//   5. Close the popover before returning so the upcoming send-button click can't land on it.
// If feature is a string[] (multi-select forward-compat), we only honour the first id today —
// ChatGPT enforces single-tool-at-a-time and toggling a second row would just deselect the
// first. The future multi-tool case is not exercised in Session 1.
async function applyToolsFeature(feature) {
  const wantId = Array.isArray(feature) ? feature[0] : feature;
  const wantLabel = wantId ? TOOL_LABEL[wantId] : null;

  const opened = await openToolsPopover();
  if (!opened) {
    console.warn('[wrapperr] ChatGPT tools popover did not open — sending without applying feature');
    return;
  }

  // Snapshot current state inside the open menu.
  const webRow  = findToolRow('web search');
  const deepRow = findToolRow('deep research');
  const webOn   = isToolRowOn(webRow);
  const deepOn  = isToolRowOn(deepRow);
  const currentlyOnLabel = webOn ? 'web search' : deepOn ? 'deep research' : null;

  // Validate Deep Research availability when it was requested. The row is hidden / absent on
  // accounts that don't have it; log clearly and proceed without it rather than silently doing
  // nothing weird.
  if (wantId === 'deep-research' && !deepRow) {
    console.warn('[wrapperr] Deep Research not available on this account (likely gated/quota-exhausted); sending without it');
    await closeToolsPopover();
    return;
  }

  // Fast path: already in target state.
  if (wantLabel === currentlyOnLabel) {
    await closeToolsPopover();
    return;
  }

  if (wantLabel) {
    // Want a specific tool ON. Click it; Radix radio semantics auto-uncheck siblings.
    const target = wantLabel === 'web search' ? webRow : deepRow;
    if (target) {
      target.click();
      // Wait for the row's state to flip.
      await waitFor(() => isToolRowOn(target), 800);
    }
  } else if (currentlyOnLabel) {
    // Want all tools OFF and one is on. Click the currently-on row to toggle it off.
    const onRow = webOn ? webRow : deepRow;
    if (onRow) {
      onRow.click();
      await waitFor(() => !isToolRowOn(onRow), 800);
    }
  }

  await closeToolsPopover();
}

// ─── Model picker (Instant / Thinking) ───────────────────────────────────────────────────────
//
// Captured DOM from chatgpt.com:
//   • Trigger: <button class="__composer-pill __composer-pill--neutral group/pill"
//              aria-haspopup="menu" aria-expanded="…" data-state="open|closed">
//     containing an inner <span> whose text is the current model label ("Instant", "Thinking",
//     "Auto" etc.). The id is a radix-generated random string — DON'T use it as a stable hook.
//   • Menu items (NOT captured in this round): assumed to follow the same Radix pattern as the
//     Tools menu — role="menuitem" or role="menuitemradio" rows with the model label as text.
//     If this assumption breaks, the fallback ladder degrades gracefully (see below). Worth a
//     capture-and-verify pass before sessions 2-5 reuse this pattern.
//
// Three ranked strategies for the model-picker trigger (best → worst):
//   1. button.__composer-pill[aria-haspopup="menu"] whose text matches a known model label —
//      uses the class + role + content to narrow to the right pill among any other composer
//      pills that may exist (e.g. a hypothetical Codex switcher).
//   2. Any button[aria-haspopup="menu"] inside the composer form whose text matches a known
//      model label — survives a class rename.
//   3. Any button whose visible text exactly matches a known model label — broadest, last
//      resort. Risks matching a model name that appears outside the picker (e.g. in chat
//      history) so we guard by preferring the closest element to the composer textarea.
const KNOWN_MODEL_LABELS = ['instant', 'thinking', 'auto', 'gpt-5', 'gpt-4o', 'o3', 'o4-mini'];

function findModelPickerTrigger() {
  // Strategy 1: class + role + known-label text.
  const pills = document.querySelectorAll('button.__composer-pill[aria-haspopup="menu"]');
  for (const b of pills) {
    const t = (b.textContent || '').trim().toLowerCase();
    if (KNOWN_MODEL_LABELS.some((m) => t.includes(m))) return b;
  }
  // Strategy 2: role-only within the composer form.
  const form = document.querySelector('form');
  if (form) {
    const candidates = form.querySelectorAll('button[aria-haspopup="menu"]');
    for (const b of candidates) {
      const t = (b.textContent || '').trim().toLowerCase();
      if (KNOWN_MODEL_LABELS.some((m) => t.includes(m))) return b;
    }
  }
  // Strategy 3: any button with model-label text, prefer the one closest to the textarea.
  const all = Array.from(document.querySelectorAll('button')).filter((b) => {
    const t = (b.textContent || '').trim().toLowerCase();
    return KNOWN_MODEL_LABELS.some((m) => t.includes(m));
  });
  if (all.length === 0) return null;
  const input = document.querySelector('#prompt-textarea') ?? document.querySelector('div[contenteditable="true"]');
  if (!input) return all[0];
  const inputRect = input.getBoundingClientRect();
  all.sort((a, b) => {
    const da = Math.hypot(a.getBoundingClientRect().left - inputRect.left, a.getBoundingClientRect().top - inputRect.top);
    const db = Math.hypot(b.getBoundingClientRect().left - inputRect.left, b.getBoundingClientRect().top - inputRect.top);
    return da - db;
  });
  return all[0];
}

// getCurrentModelLabel: read the trigger's visible label (e.g. "Thinking", "Instant"). Used as
// the cheap fast-path detector for "already in target state" — no menu open required.
function getCurrentModelLabel() {
  const trigger = findModelPickerTrigger();
  if (!trigger) return null;
  return (trigger.textContent || '').trim().toLowerCase();
}

// findModelMenuItem: locate the row inside the open model picker that matches `label`.
//
// Captured DOM (model picker open, account currently in Thinking):
//   • Instant row:  <div role="menuitemradio" aria-checked="false"
//                       data-testid="model-switcher-gpt-5-5" ...>
//                     <span>Instant</span>
//                   </div>
//   • Thinking row: <div role="menuitemradio" aria-checked="true"
//                       data-testid="model-switcher-gpt-5-5-thinking" ...>
//                     <span>Thinking <span class="hidden">• Standard</span></span>
//                   </div>
//
// The base `gpt-5-5` part of the testid changes when OpenAI ships new models, but two things
// are stable: the `model-switcher-` prefix, and the `-thinking` suffix on the thinking variant
// only. We exploit both as the top strategy.
//
// Three ranked strategies (best → worst):
//   1. data-testid pattern — `[data-testid^="model-switcher-"]`, with `:not(*$="-thinking")`
//      for Instant or `*$="-thinking"` for Thinking. Survives model id renames.
//   2. role + text match — `[role="menuitemradio|menuitem"]` whose visible text begins with
//      the label. Survives a testid rename. We use startsWith (not equality) because the
//      Thinking row includes a hidden "• Standard" sublabel inside textContent.
//   3. radix collection item or option — broadest text-match fallback for the case where the
//      role attribute itself was renamed.
function findModelMenuItem(label) {
  const want = label.toLowerCase();

  // Strategy 1: stable data-testid pattern.
  if (want === 'thinking') {
    const el = document.querySelector('[data-testid^="model-switcher-"][data-testid$="-thinking"]');
    if (el) return el;
  } else if (want === 'instant') {
    const candidates = document.querySelectorAll('[data-testid^="model-switcher-"]');
    for (const c of candidates) {
      const tid = c.getAttribute('data-testid') || '';
      if (!tid.endsWith('-thinking')) return c;
    }
  }

  // Strategy 2: role-based with lenient text match (handles hidden sublabels inside textContent).
  function matchByRole(role) {
    const rows = document.querySelectorAll(`[role="${role}"]`);
    for (const r of rows) {
      const t = (r.textContent || '').trim().toLowerCase();
      if (t === want || t.startsWith(want)) return r;
    }
    return null;
  }
  const byRadio = matchByRole('menuitemradio');
  if (byRadio) return byRadio;
  const byItem = matchByRole('menuitem');
  if (byItem) return byItem;

  // Strategy 3: collection items / options, text match.
  const rows = document.querySelectorAll('[data-radix-collection-item], [role="option"]');
  for (const r of rows) {
    const t = (r.textContent || '').trim().toLowerCase();
    if (t === want || t.startsWith(want)) return r;
  }
  return null;
}

// applyModelIntelligence: switch the model picker to the requested label. Fast-path on label
// match; otherwise open trigger, click the matching row, wait for trigger label to update,
// fall back to Escape if the menu didn't close on selection.
async function applyModelIntelligence(intelligence) {
  // Map our ids to ChatGPT's labels. The intelligence pill in aiFeatures.ts only lists Instant
  // and Thinking today.
  const MODEL_LABEL = { 'instant': 'instant', 'thinking': 'thinking' };
  const wantLabel = MODEL_LABEL[intelligence];
  if (!wantLabel) return; // unknown id → leave model alone

  const current = getCurrentModelLabel();
  if (current && current.includes(wantLabel)) return; // already there — fast path

  const trigger = findModelPickerTrigger();
  if (!trigger) {
    console.warn('[wrapperr] ChatGPT model picker not found — sending with current model');
    return;
  }

  // Open menu via pointer-event sequence (Radix DropdownMenu requires pointerdown).
  if (trigger.getAttribute('aria-expanded') !== 'true') {
    radixOpen(trigger);
    const opened = await waitFor(() => trigger.getAttribute('aria-expanded') === 'true', 1500);
    if (!opened) {
      console.warn('[wrapperr] ChatGPT model picker did not open — sending with current model');
      return;
    }
  }

  const item = await waitFor(() => findModelMenuItem(wantLabel), 1000);
  if (!item) {
    console.warn(`[wrapperr] ChatGPT model "${wantLabel}" row not found — sending with current model`);
    // Try to close the menu so the send button isn't covered.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }
  item.click();

  // Wait for trigger label to flip to the new model OR for the menu to close.
  await waitFor(() => {
    const t = (findModelPickerTrigger()?.textContent || '').trim().toLowerCase();
    return t.includes(wantLabel) || trigger.getAttribute('aria-expanded') !== 'true';
  }, 1000);

  // Belt-and-braces: ensure the menu is closed before returning.
  if (findModelPickerTrigger()?.getAttribute('aria-expanded') === 'true') {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await sleep(100);
  }
}

// Listener guard: see comment in shared file. SW re-injection would otherwise stack listeners.
if (!window.__wrapperrAIListenerOn) {
  window.__wrapperrAIListenerOn = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'WRAPPERR_INJECT_ONLY') {
      (async () => {
        try {
          // Baseline first so applyOptions' DOM activity can't pollute the assistant-message
          // count (it only opens menus/popovers — no new assistant nodes — but defensive).
          const baseline = getBaseline();
          // applyOptions is best-effort: even on internal failure it returns without throwing,
          // so injection always runs. msg.options is undefined for legacy callers — applyOptions
          // is a no-op in that case.
          await applyOptions(msg.options || {});
          await injectMessage(msg.message);
          sendResponse({ ok: true, baseline });
        } catch (err) {
          sendResponse({ ok: false, error: err.message });
        }
      })();
      return true;
    }
    if (msg.type === 'WRAPPERR_GET_STATE') {
      try {
        sendResponse({ text: getCurrentState(msg) });
      } catch (err) {
        sendResponse({ text: '', error: err.message });
      }
      return false;
    }
    if (msg.type === 'WRAPPERR_REREAD_LATEST') {
      try { sendResponse({ text: readLatestResponse() }); }
      catch (err) { sendResponse({ text: '', error: err.message }); }
      return false;
    }
  });
}

} // end load guard
