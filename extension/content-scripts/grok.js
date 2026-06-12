// ─── Load guard ──────────────────────────────────────────────────────────────────────────────
// chrome.scripting.executeScript re-runs this file every time the SW calls sendToAI. Top-level
// `const RESPONSE_SELECTOR` and `const MODE_LABELS` would throw SyntaxError on re-declaration —
// caught by the SW's try/catch, harmless functionally, but noisy in the grok.com console.
// Wrapping the whole file in a one-time guard makes the second injection a clean no-op. The
// first injection's chrome.runtime listener (separately guarded below) stays live and handles
// every subsequent send. Mirrors chatgpt.js::__wrapperrChatGPTLoaded and claude.js::__wrapperrClaudeLoaded.
if (!window.__wrapperrGrokLoaded) {
  window.__wrapperrGrokLoaded = true;

// injectMessage: locate Grok's Tiptap/ProseMirror contenteditable composer and submit.
//
// All actual typing logic lives in _wrapperr-input.js (contenteditable strategy via
// execCommand('insertHTML') with <p>-wrapped lines). ProseMirror's mutation observer
// reconciles the DOM mutation cleanly — synthetic ClipboardEvent paste doesn't work
// cross-world (isolated content-script world is invisible to MAIN-world editors).
async function injectMessage(message) {
  const input = document.querySelector('div[data-testid="chat-input"] div[contenteditable="true"]')
    ?? document.querySelector('.tiptap.ProseMirror[contenteditable="true"]')
    ?? document.querySelector('div[contenteditable="true"][translate="no"]');
  if (!input) throw wrapperrError('AI_INJECT_INPUT_NOT_FOUND', { ai: 'grok', details: { url: location.href, selectorsTried: ['div[data-testid="chat-input"] div[contenteditable="true"]', '.tiptap.ProseMirror[contenteditable="true"]', 'div[contenteditable="true"][translate="no"]'] } });

  await wrapperrInjectInput(input, { kind: 'text', text: message });

  // Send button has data-testid="chat-submit" + aria-label="Submit"; either is stable.
  // Enter keydown fallback exists for the rare case where the button is still :disabled
  // when we click (Tiptap binds Enter to submit on its own).
  const sendBtn = document.querySelector('button[data-testid="chat-submit"]')
    ?? document.querySelector('button[type="submit"][aria-label="Submit"]');

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// DOM-scrape fallback selector — last resort only. Grok renders Markdown as HTML, so reading
// innerText here loses formatting symbols (#, **, fence ticks). The grace window in
// getCurrentState exists precisely to avoid hitting this path while the network buffer is
// still filling.
const RESPONSE_SELECTOR =
  '[class*="message"][class*="assistant"], [data-message-author="grok"], [class*="response-content-markdown"], [class*="markdown"]';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/grok-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and
// expose the global readBestGrokText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// Grok's DOM renders markdown as HTML; falling back too early returns plain text and the SW
// considers it stable, discarding the markdown forever. 3 s grace mirrors Gemini's fix for
// the same failure mode.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestGrokText(sentAt);
  if (netText) {
    window.__wrapperrGrokDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrGrokDomGrace) window.__wrapperrGrokDomGrace = now;
  if (now - window.__wrapperrGrokDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

// readLatestResponse: see chatgpt.js. Network buffer preferred (Grok's DOM strips markdown);
// DOM fallback uses the same RESPONSE_SELECTOR as getBaseline.
function readLatestResponse() {
  const netText = readBestGrokText(0);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const last = messages[messages.length - 1];
  return last ? wrapperrBestText(last) : '';
}

// ─── applyOptions helpers ────────────────────────────────────────────────────────────────────

// sleep: trivial promise timer. Used by waitFor's polling loop. Kept as a named helper instead
// of inline `new Promise((r) => setTimeout(r, ms))` for readability and to match chatgpt.js.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// popoverOpen: Grok's mode-picker trigger is a Radix-style button (it carries aria-expanded
// AND data-state attributes that flip on open — classic Radix DropdownMenu signature). Like
// other Radix triggers, it listens on `pointerdown` — a synthetic `.click()` fires the `click`
// event but skips pointerdown, so the menu never opens. We dispatch the full pointer → mouse
// → click sequence at the element's centre to satisfy the open intent. Row clicks (selecting
// a mode, not opening a menu) stay on plain `.click()` because the rows DO respond to it.
// Mirrors chatgpt.js::radixOpen and claude.js::popoverOpen.
// CRITICAL: if grok.com ever switches to a library that double-handles both pointerdown AND
// click on the trigger, this will fire open AND immediately close it — watch for menu flicker
// as the first symptom.
function popoverOpen(el) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, composed: true, view: window, clientX: x, clientY: y };
  const down = { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1 };
  const up   = { ...base, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', down));
  el.dispatchEvent(new MouseEvent('mousedown', { ...base, button: 0, buttons: 1 }));
  el.dispatchEvent(new PointerEvent('pointerup', up));
  el.dispatchEvent(new MouseEvent('mouseup', { ...base, button: 0, buttons: 0 }));
  el.dispatchEvent(new MouseEvent('click', { ...base, button: 0, buttons: 0 }));
}

// withTimeout: race a promise against a timer. Used to enforce the per-action time budget
// without dragging AbortController plumbing through every helper. The rejection still allows
// the caller's try/catch to swallow and proceed to injection. Same pattern as chatgpt.js.
function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`applyOptions step timed out after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// waitFor: poll a predicate every 50 ms up to maxMs, resolving with its truthy return or null
// on timeout. Used everywhere we expect a DOM mutation (menu opens, row appears, trigger label
// updates). Errors thrown by the predicate are swallowed silently so a one-off null deref
// during animation doesn't kill the wait.
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

// ─── applyOptions orchestrator ───────────────────────────────────────────────────────────────

// applyOptions: best-effort apply Grok's mode selection BEFORE injecting the prompt. Shape:
//   { intelligence?: 'fast'|'auto'|'expert'|'heavy' }
// Grok's web/lib/aiFeatures.ts entry declares no `feature` and no `style` pill, so those keys
// will never arrive populated — but we still defensively no-op rather than throw if they do
// (forward-compat if the spec gains pills later).
//
// Hard contract: applyOptions MUST NOT throw. The per-slot call is wrapped in try/catch + a
// time budget; on failure we log and fall through to injection. Better to send the prompt
// without the mode toggle than to abort entirely. Total budget ~10 s, per action ~5 s. The
// user-set timeoutMs in extension.ts covers the whole round-trip — slow applyOptions just
// eats into the reply budget, it doesn't add its own.
async function applyOptions(options) {
  if (!options || typeof options !== 'object') return;
  if (options.intelligence === undefined) return;  // nothing to do (user hasn't picked a Mode)

  const TOTAL_BUDGET_MS = 10000;
  const PER_ACTION_MS = 5000;
  const start = Date.now();
  const remaining = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - start));

  // Mode (intelligence slot) — Fast / Auto / Expert / Heavy. Skipped silently when undefined
  // above. For known values we still run even if we believe the current state matches —
  // getCurrentModeLabel reads cheaply from the trigger's inner span so the fast-path is free.
  try {
    if (remaining() > 0) {
      await withTimeout(applyIntelligence(options.intelligence), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] Grok applyIntelligence failed:', err && err.message || err);
  }
}

// ─── Mode picker (intelligence slot) ─────────────────────────────────────────────────────────
//
// Captured DOM from grok.com on a logged-in account (fresh chat, 2026-06):
//   • Trigger:
//       <button id="model-select-trigger" aria-label="Model select"
//               aria-haspopup="menu" aria-expanded="false|true"
//               data-state="closed|open" type="button" …>
//         <span class="flex items-center gap-1.5">
//           <span class="flex items-center gap-1 overflow-hidden" …>
//             <span class="truncate text-sm font-semibold">Fast</span>   ← current mode label
//           </span>
//         </span>
//         <svg …>chevron</svg>
//       </button>
//   • Each mode row (inner content only — the user didn't capture the wrapping clickable
//     element, presumed to be [role="menuitem"] per Radix DropdownMenu defaults):
//       <div class="flex flex-col items-start">
//         <div class="flex items-center gap-1">
//           <span class="font-semibold text-sm">Fast</span>          ← bold label
//         </div>
//         <span class="text-xs text-secondary line-clamp-1">Powered by Grok 4.3</span>
//       </div>
//     IMPORTANT: we MUST match on the bold-label span, NOT the full row textContent. Auto's
//     description reads "Chooses Fast or Expert", which would otherwise falsely match the
//     Fast and Expert rows.

// MODE_LABELS: map Wrapperr's lowercase ids → Grok's user-facing labels. Both directions are
// done via key/value lookups. To add a new Grok mode in the future, update BOTH this map AND
// web/lib/aiFeatures.ts's grok.intelligence.options array — the two must stay in sync.
const MODE_LABELS = { fast: 'Fast', auto: 'Auto', expert: 'Expert', heavy: 'Heavy' };

// findModelTrigger: locate Grok's mode-picker button via three ranked strategies (best→worst).
// Returns the first non-null. The 3-fallbacks rule (CLAUDE.md project requirement): grok.com
// iterates its UI weekly and single-selector implementations break — three rungs mean a class
// rename, id rename, or aria-label tweak each only kills one strategy.
//   1. #model-select-trigger        — exact id, the most stable hook today.
//   2. button[aria-label="Model select"]  — exact accessibility label, slow to churn because
//                                            screen-reader tooling depends on it.
//   3. button[aria-haspopup="menu"][id*="model"]  — semantic fuzzy match; survives a wholesale
//                                                   id/label rewrite as long as the trigger
//                                                   keeps its popup role and "model" stays
//                                                   somewhere in the id.
function findModelTrigger() {
  return document.getElementById('model-select-trigger')
      ?? document.querySelector('button[aria-label="Model select"]')
      ?? (() => {
        const candidates = document.querySelectorAll('button[aria-haspopup="menu"]');
        for (const b of candidates) {
          const id = (b.id || '').toLowerCase();
          if (id.includes('model')) return b;
        }
        return null;
      })();
}

// getCurrentModeLabel: read the trigger button's displayed mode (e.g. "Fast"). Used both to
// short-circuit when the requested mode is already active and to verify the click landed.
// Three ranked strategies for finding the label span inside the trigger (best→worst):
//   1. span.truncate.font-semibold inside the trigger — exact class match per current DOM.
//   2. span.font-semibold inside the trigger          — drop .truncate if Grok renames it.
//   3. Scan the trigger's full textContent for any of the four mode names as whole words —
//      last-resort substring match; works even after the inner span structure changes.
function getCurrentModeLabel() {
  const trigger = findModelTrigger();
  if (!trigger) return null;
  const exact = trigger.querySelector('span.truncate.font-semibold');
  if (exact) return (exact.textContent || '').trim();
  const fallback = trigger.querySelector('span.font-semibold');
  if (fallback) return (fallback.textContent || '').trim();
  const all = (trigger.textContent || '').trim();
  for (const label of Object.values(MODE_LABELS)) {
    if (new RegExp(`\\b${label}\\b`, 'i').test(all)) return label;
  }
  return null;
}

// openModelMenu: open the mode dropdown. Idempotent — returns true immediately when the
// trigger already reports aria-expanded="true". Uses popoverOpen() for the synthetic
// pointer-event sequence Radix expects. Returns true on success, false if the trigger is
// missing or the menu never opens within 1.5 s.
async function openModelMenu() {
  const trigger = findModelTrigger();
  if (!trigger) return false;
  if (trigger.getAttribute('aria-expanded') === 'true') return true;
  popoverOpen(trigger);
  const opened = await waitFor(
    () => trigger.getAttribute('aria-expanded') === 'true' ? trigger : null,
    1500
  );
  return !!opened;
}

// closeModelMenu: dismiss the mode dropdown if it's still open after a click. Claude needed
// the same fix (commit e3d25cd) — some Radix menus stay open after a row click depending on
// how the item handler is wired, and we don't want to leave the user with a half-open menu
// hovering over their composer.
// Two-step strategy: dispatch Escape on the trigger (works for Radix/Headless UI menus);
// if still open after 500 ms, toggle it closed via popoverOpen on the trigger (a second open
// gesture flips data-state back to "closed" on Radix DropdownMenu).
async function closeModelMenu() {
  const trigger = findModelTrigger();
  if (!trigger) return;
  if (trigger.getAttribute('aria-expanded') !== 'true') return;
  trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  const closed = await waitFor(
    () => trigger.getAttribute('aria-expanded') === 'false' ? trigger : null,
    500
  );
  if (closed) return;
  popoverOpen(trigger);
}

// findModeRow: find the clickable menu row for a given mode label inside the open dropdown.
// Three ranked strategies (best→worst). Matching is done against the bold .font-semibold span
// inside each row — see the warning in the captured-DOM comment above about Auto's description
// falsely matching Fast/Expert if we matched on full row text.
//   1. [role="menuitem"] containing a span.font-semibold whose trimmed text exactly equals
//      the target label (case-insensitive) — strongest, matches the Radix DropdownMenu role.
//   2. [role="menuitemradio"] with the same span match — fallback if Grok renders the modes
//      as a radio group (single-select semantics) instead of plain menuitems.
//   3. ANY span.font-semibold whose trimmed text exactly equals the target label, then walk
//      up to the nearest clickable ancestor. Excludes the trigger itself (it has
//      aria-haspopup="menu" or the known id) so we don't "click" the trigger thinking it's
//      a row — which would just close the menu and break the flow.
function findModeRow(label) {
  const want = (label || '').trim().toLowerCase();
  if (!want) return null;

  function matchByRole(role) {
    const rows = document.querySelectorAll(`[role="${role}"]`);
    for (const r of rows) {
      const lbl = r.querySelector('span.font-semibold');
      if (!lbl) continue;
      if ((lbl.textContent || '').trim().toLowerCase() === want) return r;
    }
    return null;
  }

  return matchByRole('menuitem')
      ?? matchByRole('menuitemradio')
      ?? (() => {
        const spans = document.querySelectorAll('span.font-semibold');
        for (const s of spans) {
          if ((s.textContent || '').trim().toLowerCase() !== want) continue;
          // Prefer a menu-role ancestor first; only fall through to a plain button if it isn't
          // the trigger itself.
          const menuItem = s.closest('[role="menuitem"], [role="menuitemradio"], [role="option"], [data-radix-collection-item]');
          if (menuItem) return menuItem;
          const btn = s.closest('button');
          if (!btn) continue;
          if (btn.id === 'model-select-trigger') continue;
          if (btn.getAttribute('aria-haspopup') === 'menu') continue;
          return btn;
        }
        return null;
      })();
}

// applyIntelligence: switch grok.com's mode to modeId (fast/auto/expert/heavy). Best-effort —
// throws on hard failure (no trigger, can't open menu, row not found, click didn't land), and
// the orchestrator above catches and warns. Steps:
//   1. Resolve the user-visible label for modeId. Unknown id → silent return (forward-compat
//      if web/lib/aiFeatures.ts adds a mode before this map does).
//   2. Read current mode from the trigger; if it already matches, no-op (don't re-open the
//      menu just to click the same row — that risks an unwanted close/open cycle).
//   3. Open the menu via openModelMenu (popoverOpen + wait for aria-expanded=true).
//   4. Find the target row via findModeRow's 3-strategy ladder.
//   5. Plain .click() the row — rows are not Radix triggers, so .click() suffices.
//   6. Wait up to 2 s for the trigger label to show the new mode (proof the click landed).
//   7. Force-close the menu if it stayed open — keeps the composer area clean.
// Tier-locked modes (Heavy/Expert on free accounts) typically render the row as disabled or
// aria-disabled — .click() becomes a no-op and we'll throw on the verify step. The orchestrator
// warns and the send proceeds without the switch, which matches the project's "never block
// the send" contract.
async function applyIntelligence(modeId) {
  const targetLabel = MODE_LABELS[modeId];
  if (!targetLabel) return;  // unknown id — treat as no-op for forward-compat

  const current = getCurrentModeLabel();
  if (current && current.toLowerCase() === targetLabel.toLowerCase()) return;

  const opened = await openModelMenu();
  if (!opened) throw new Error('could not open Grok mode menu');

  const row = findModeRow(targetLabel);
  if (!row) {
    await closeModelMenu();
    throw new Error(`mode row "${targetLabel}" not found in open menu`);
  }

  row.click();

  const ok = await waitFor(() => {
    const c = getCurrentModeLabel();
    return c && c.toLowerCase() === targetLabel.toLowerCase();
  }, 2000);

  await closeModelMenu();

  if (!ok) throw new Error(`mode did not switch to "${targetLabel}" after click`);
}

// Message listener — guarded against double-installation if the script is re-injected.
// Same shape as gemini.js / chatgpt.js / claude.js: WRAPPERR_INJECT_ONLY captures baseline,
// applies per-AI options (Grok: Mode), then injects. WRAPPERR_GET_STATE returns the current
// best response text for the SW's stability poller. WRAPPERR_REREAD_LATEST returns the
// freshest last-assistant-message text without any inject. applyOptions is best-effort: any
// failure inside it is caught and logged (see applyOptions itself), so a broken selector
// never blocks the send.
if (!window.__wrapperrAIListenerOn) {
  window.__wrapperrAIListenerOn = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'WRAPPERR_INJECT_ONLY') {
      (async () => {
        try {
          const baseline = getBaseline();
          await applyOptions(msg.options || {});
          await injectMessage(msg.message);
          sendResponse({ ok: true, baseline });
        } catch (err) {
          sendResponse({ ok: false, error: toWrapperrError(err, 'AI_INJECT_INPUT_NOT_FOUND', { ai: 'grok', requestId: msg.requestId }) });
        }
      })();
      return true;
    }
    if (msg.type === 'WRAPPERR_GET_STATE') {
      try { sendResponse({ text: getCurrentState(msg) }); }
      catch (err) { sendResponse({ text: '', error: err.message }); }
      return false;
    }
    if (msg.type === 'WRAPPERR_REREAD_LATEST') {
      try { sendResponse({ text: readLatestResponse() }); }
      catch (err) { sendResponse({ text: '', error: err.message }); }
      return false;
    }
  });
}

}  // end of load guard (__wrapperrGrokLoaded)
