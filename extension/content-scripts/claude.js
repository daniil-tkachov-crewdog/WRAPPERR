// Load guard: chrome.scripting.executeScript re-runs this file every time the SW calls
// sendToAI. Top-level `const` declarations (RESPONSE_SELECTOR, TOOL_LABEL, STYLE_LABEL,
// MODEL_LABEL, KNOWN_MODEL_LABELS) would throw SyntaxError on re-declaration — caught by the
// SW's try/catch, harmless functionally, but noisy in the claude.ai console. Wrapping the
// whole file in a one-time guard makes the second injection a clean no-op. The first
// injection's chrome.runtime listener stays live and handles every subsequent send.
// Mirrors chatgpt.js's `__wrapperrChatGPTLoaded` guard.
if (!window.__wrapperrClaudeLoaded) {
  window.__wrapperrClaudeLoaded = true;

// injectMessage: locate Claude's ProseMirror/Tiptap contenteditable and submit.
//
// All actual typing logic lives in _wrapperr-input.js. Claude's composer is a contenteditable
// <div> driven by ProseMirror+Tiptap, so we pass the 'contenteditable' strategy explicitly
// (execCommand insertHTML with paragraph-wrapped lines). Earlier versions of this file did
// their own execCommand('insertText') here, which Tiptap's mutation observer sometimes
// swallowed and left the send button disabled — the shared helper handles this in one place
// for every AI and matches the path ProseMirror expects.
async function injectMessage(message) {
  // Locate the composer. Confirmed from a live session sample: the editor is a
  // <div contenteditable="true" data-testid="chat-input" class="tiptap ProseMirror" …>.
  // We try data-testid first (Claude's own stable attribute), then the ProseMirror class,
  // then any contenteditable as a last resort.
  const input = document.querySelector('div[contenteditable="true"][data-testid="chat-input"]')
    ?? document.querySelector('div[contenteditable="true"].ProseMirror')
    ?? document.querySelector('div[contenteditable="true"][aria-label*="prompt"]')
    ?? document.querySelector('div[contenteditable="true"]');
  if (!input) throw wrapperrError('AI_INJECT_INPUT_NOT_FOUND', { ai: 'claude', details: { url: location.href, selectorsTried: ['div[contenteditable="true"][data-testid="chat-input"]', 'div[contenteditable="true"].ProseMirror', 'div[contenteditable="true"][aria-label*="prompt"]', 'div[contenteditable="true"]'] } });

  await wrapperrInjectInput(input, { kind: 'text', text: message, strategy: 'contenteditable' });

  // Send button: <button aria-label="Send message">. The button starts disabled and only
  // enables once Claude's editor state has registered the inserted text, so we poll briefly
  // before clicking. Enter-keydown fallback exists in case React's onClick handler ignores
  // a synthetic .click() — Claude's composer also submits on Enter.
  const sendBtn = await waitForEnabledSendButton(1000);

  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// waitForEnabledSendButton: polls for an enabled aria-label="Send message" button for up to
// timeoutMs. Required because Tiptap propagates the content change asynchronously — clicking
// too fast hits a disabled button and the click is a no-op (the previous failure mode).
async function waitForEnabledSendButton(timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const btn = document.querySelector('button[aria-label="Send message"]')
      ?? document.querySelector('button[aria-label="Send Message"]')
      ?? [...document.querySelectorAll('button')].find(
          (b) => b.getAttribute('aria-label')?.toLowerCase() === 'send message'
        );
    if (btn && !btn.disabled) return btn;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

// DOM-scrape fallback selector — last resort only. Claude renders Markdown as HTML, so
// reading innerText here loses formatting symbols (#, **, fence ticks). The grace window in
// getCurrentState exists precisely to avoid hitting this path while the network buffer is
// still filling. Selector matches the assistant turn container historically used by Claude.
const RESPONSE_SELECTOR = '[data-testid="user-message"] ~ *, .font-claude-message, [data-test-render-count]';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/claude-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and
// expose the global readBestClaudeText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// Claude's DOM renders markdown as HTML; falling back too early returns plain text and the
// SW considers it stable, discarding the markdown forever. 3 s grace mirrors DeepSeek's /
// Gemini's / Grok's fix for the same failure mode.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestClaudeText(sentAt);
  if (netText) {
    window.__wrapperrClaudeDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrClaudeDomGrace) window.__wrapperrClaudeDomGrace = now;
  if (now - window.__wrapperrClaudeDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

// readLatestResponse: see chatgpt.js for the rationale. Used by Compare's per-slide recheck.
// Network buffer preferred (markdown fidelity); DOM fallback uses the same RESPONSE_SELECTOR
// as getBaseline so we always read whatever Claude is currently showing as the latest reply.
function readLatestResponse() {
  const netText = readBestClaudeText(0);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const last = messages[messages.length - 1];
  return last ? wrapperrBestText(last) : '';
}

// ─── applyOptions helpers ────────────────────────────────────────────────────────────────────

// sleep: trivial timer used for grace periods between Base UI menu open and item click.
// Most state-flip waits use waitFor() (polled) instead — sleep is only for the cases where we
// don't have a stable predicate (e.g. submenu open animation).
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// popoverOpen: claude.ai's composer menus (Tools popover, Use style submenu, Model picker)
// are Base UI DropdownMenus (the cds-reset / `base-ui-_r_*` id pattern). Like Radix, Base UI
// listens for `pointerdown` on the trigger — a synthetic `.click()` fires the `click` event
// but skips `pointerdown`, so the menu never opens. We dispatch the full pointer→mouse→click
// sequence at the element's centre to satisfy both libraries. Row clicks (select actions,
// not triggers) stay on plain `.click()` because the rows DO respond to it.
// CRITICAL: if claude.ai ever switches to a library that double-handles both pointerdown and
// click on the trigger, this helper will fire the open AND immediately close it — watch for
// the menu flickering open/closed in the console as the first symptom.
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
// on timeout. Used everywhere we expect a DOM mutation (menu opens, submenu appears, row
// aria-checked flips, trigger label updates). Errors thrown by the predicate are swallowed
// silently so a one-off null deref during animation doesn't kill the wait.
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

// applyOptions: best-effort apply per-AI feature toggles BEFORE injecting the prompt. Shape:
//   { feature?: 'research'|'web-search', style?: 'normal'|…|'pragmatic-analyst',
//     intelligence?: 'opus-4-8'|'sonnet-4-6'|'haiku-4-5' }
// The ids come from web/lib/aiFeatures.ts's Claude entry. options.skills is intentionally
// never sent (UI dims the pill) — defensive no-op if it ever arrives.
//
// Hard contract: applyOptions MUST NOT throw. Each action runs inside its own try/catch + a
// per-action time budget; on failure we log and fall through to injection. Better to send the
// prompt without a toggle than to abort entirely. Total budget ~10 s, per action ~5 s. The
// user-set timeoutMs in extension.ts covers the whole round-trip — slow applyOptions just
// eats into the reply budget, it doesn't add its own.
async function applyOptions(options) {
  if (!options || typeof options !== 'object') return;
  const hasAny = options.feature !== undefined
              || options.style !== undefined
              || options.intelligence !== undefined;
  if (!hasAny) return;

  const TOTAL_BUDGET_MS = 10000;
  const PER_ACTION_MS = 5000;
  const start = Date.now();
  const remaining = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - start));

  // Tools (feature slot) — Research / Web search / none. Always run, even when feature is
  // undefined: the user may have explicitly cleared the pill and we should reflect that on
  // claude.ai by un-checking any currently-on tool.
  try {
    if (remaining() > 0) {
      await withTimeout(applyToolsFeature(options.feature), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] Claude applyToolsFeature failed:', err && err.message || err);
  }

  // Style — six options, single-selected via the Use style submenu inside the Tools popover.
  // Skip silently when undefined (no Wrapperr selection → leave claude.ai's current style
  // alone). The user can explicitly choose 'normal' to reset to Claude's default style.
  try {
    if (options.style !== undefined && remaining() > 0) {
      await withTimeout(applyStyle(options.style), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] Claude applyStyle failed:', err && err.message || err);
  }

  // Model (intelligence slot) — Opus 4.8 / Sonnet 4.6 / Haiku 4.5. Skip silently when
  // undefined (leave model alone). For known values we still run even if we believe the
  // current state matches — getCurrentModelLabel reads cheaply from the trigger's
  // aria-label so the fast-path is essentially free.
  try {
    if (options.intelligence !== undefined && remaining() > 0) {
      await withTimeout(applyModelIntelligence(options.intelligence), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] Claude applyModelIntelligence failed:', err && err.message || err);
  }
}

// ─── Tools popover (Research / Web search) ───────────────────────────────────────────────────
//
// Captured DOM from claude.ai (logged-in Pro account, fresh chat):
//   • Trigger: <button type="button" data-cds="Button"
//              aria-label="Add files, connectors, and more"
//              aria-haspopup="menu" aria-expanded="false|true" id="_r_a6_">
//     The id is a Base UI random suffix — never stable, never used as a hook.
//   • Each toggle row (Research, Web search) lives in the popover (alongside submenu rows
//     for Use style / Skills / Connectors / Add plugins) and has:
//       <div role="menuitemcheckbox" tabindex="-1" id="base-ui-_r_cp_"
//            aria-checked="true|false" data-checked="" | data-unchecked="" …>
//         <span class="block truncate">Research</span> (or "Web search")
//       </div>
//     Checkbox semantics — Research and Web search toggle independently in the native UI.
//     Wrapperr's pill is single-select (radio behavior), so we enforce "only the requested
//     tool is on" by clearing the other when needed. If Anthropic later flips these to
//     menuitemradio we still match via the second/third ladder rungs below.
//
// Three ranked strategies for the Tools trigger (best→worst). Each strategy is tried in
// order and the first non-null wins:
//   1. button[aria-label="Add files, connectors, and more"] — exact accessibility-label
//      match. aria-label is the most stable identifier on Claude's composer because it's
//      maintained for screen-reader compliance (slow to churn) and there's only one button
//      with this label.
//   2. button[data-cds="Button"][aria-haspopup="menu"][aria-label*="connectors" i] —
//      partial aria-label match against the unique-ish word "connectors", scoped to the
//      Claude Design System button + popup role. Survives a label rewording that still
//      mentions connectors.
//   3. The first button[aria-haspopup="menu"] inside the form/composer container whose
//      aria-label mentions "add" or "files" — broadest. Survives a full label rewrite as
//      long as the menu trigger keeps its popup role.
function findToolsTrigger() {
  const exact = document.querySelector('button[aria-label="Add files, connectors, and more"]');
  if (exact) return exact;
  const partial = document.querySelector('button[data-cds="Button"][aria-haspopup="menu"][aria-label*="connectors" i]');
  if (partial) return partial;
  // Strategy 3 — composer-scoped fuzzy match.
  const form = document.querySelector('form')
    ?? document.querySelector('div[contenteditable="true"][data-testid="chat-input"]')?.closest('form, fieldset, div[role="region"], main');
  const scope = form ?? document;
  const candidates = scope.querySelectorAll('button[aria-haspopup="menu"]');
  for (const b of candidates) {
    const label = (b.getAttribute('aria-label') || '').toLowerCase();
    if (label.includes('add') || label.includes('files') || label.includes('connectors')) return b;
  }
  return null;
}

// Three ranked strategies for finding a row inside the open Tools popover. `label` is
// matched case-insensitively against the row's trimmed text using includes() (so "Web search"
// matches even if Claude later capitalises it as "Web Search"):
//   1. [role="menuitemcheckbox"] whose text matches — strongest, exact role used today.
//   2. [role="menuitem"] whose text matches — fallback if Claude rewrites to a select-style
//      row (single-select item with checkmark) or strips the checkbox role.
//   3. [id^="base-ui-"] whose text matches — broadest, catches any Base UI menu item even
//      after role rename.
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
  return matchByRole('menuitemcheckbox')
      ?? matchByRole('menuitem')
      ?? (() => {
        const rows = document.querySelectorAll('[id^="base-ui-"]');
        for (const r of rows) {
          const t = (r.textContent || '').trim().toLowerCase();
          if (t.includes(want)) return r;
        }
        return null;
      })();
}

// isRowChecked: read the checked state of a menuitemcheckbox row. aria-checked is the
// accessibility-grade source of truth; data-checked / data-unchecked is the visual one.
// We prefer aria-checked because it survives styling refactors that drop the data-* hooks.
function isRowChecked(row) {
  if (!row) return false;
  const aria = row.getAttribute('aria-checked');
  if (aria === 'true') return true;
  if (aria === 'false') return false;
  if (row.hasAttribute('data-checked')) return true;
  if (row.hasAttribute('data-unchecked')) return false;
  return false;
}

// openToolsPopover: clicks the trigger via popoverOpen (pointer-event sequence) and waits
// for aria-expanded=true. Idempotent if already open. Returns true on success, false on
// failure (trigger missing or popover never opens within the wait window).
async function openToolsPopover() {
  const trigger = findToolsTrigger();
  if (!trigger) return false;
  if (trigger.getAttribute('aria-expanded') === 'true') return true;
  popoverOpen(trigger);
  const ok = await waitFor(() => trigger.getAttribute('aria-expanded') === 'true', 1500);
  return Boolean(ok);
}

// dismissOpenMenu: synthetic outside-click that closes any Base UI / Radix portal-rendered
// menu. Those libraries register document-level pointerdown/mousedown listeners and dismiss
// when the event's target isn't contained in the menu element. We dispatch directly on
// document.body so the event's target IS body — guaranteed outside any menu — and limit the
// payload to the two events the dismiss path actually listens for. We do NOT fire pointerup
// or click, because those could activate something visible at (1, 1) (e.g. a sidebar chat
// item in claude.ai) and navigate away from the current conversation before the prompt is
// even sent. CRITICAL: if a future library version listens on `click` only, dismissal will
// silently stop working and menus will stay open — Escape and trigger-toggle fallbacks in
// closeToolsPopover catch that case.
function dismissOpenMenu() {
  document.body.dispatchEvent(new PointerEvent('pointerdown', {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: 1, clientY: 1, pointerType: 'mouse', pointerId: 1, isPrimary: true, button: 0, buttons: 1,
  }));
  document.body.dispatchEvent(new MouseEvent('mousedown', {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: 1, clientY: 1, button: 0, buttons: 1,
  }));
}

// closeToolsPopover: dismiss the Tools popover (and any open submenu inside it) so the
// upcoming send-button click can't land on the menu surface, and so the user doesn't see a
// stranded open menu when they revisit the claude.ai tab. Three escalating strategies:
//   1. Outside-click via dismissOpenMenu — works for Base UI / Radix portal menus that
//      bind on document pointerdown/mousedown. This is the only strategy that reliably
//      closes BOTH the root popover and any nested submenu in one shot.
//   2. Escape keydown on document — covers libraries that scope the dismiss listener to
//      the menu element. Fired twice with a small gap because a submenu intercepts the
//      first Escape and the root popover catches the second.
//   3. Toggle the trigger — last-resort, only if everything else left the popover open.
async function closeToolsPopover() {
  dismissOpenMenu();
  let closed = await waitFor(() => {
    const t = findToolsTrigger();
    return !t || t.getAttribute('aria-expanded') !== 'true';
  }, 500);
  if (closed) return;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(60);
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  closed = await waitFor(() => {
    const t = findToolsTrigger();
    return !t || t.getAttribute('aria-expanded') !== 'true';
  }, 500);
  if (closed) return;
  const trigger = findToolsTrigger();
  if (trigger && trigger.getAttribute('aria-expanded') === 'true') {
    popoverOpen(trigger);
    await waitFor(() => trigger.getAttribute('aria-expanded') !== 'true', 500);
  }
}

// Map Wrapperr feature ids → Claude UI labels. Lowercase because findToolRow matches
// case-insensitively. If Anthropic renames a tool, change the value here only.
const TOOL_LABEL = {
  'research':   'research',
  'web-search': 'web search',
};

// applyToolsFeature: set the Tools state to match the requested feature id, or clear all
// tools when feature is undefined. Flow:
//   1. Open the popover.
//   2. Read current Research / Web search states.
//   3. If currently in target state → close, return (fast path).
//   4. Otherwise: click the desired row to enable it; click any other currently-on tool to
//      disable it. Each click is followed by waitFor on its row's aria-checked.
//   5. Close the popover before returning.
// `feature` may be a string[] in the future (multi-select pill) — we honour only the first
// id today since the Wrapperr UI is single-select; multi-select wiring belongs in a future
// session and would also require InputBar changes.
async function applyToolsFeature(feature) {
  const wantId = Array.isArray(feature) ? feature[0] : feature;
  const wantLabel = wantId ? TOOL_LABEL[wantId] : null;

  const opened = await openToolsPopover();
  if (!opened) {
    console.warn('[wrapperr] Claude tools popover did not open — sending without applying feature');
    return;
  }

  const researchRow = findToolRow('research');
  const webRow      = findToolRow('web search');
  const researchOn  = isRowChecked(researchRow);
  const webOn       = isRowChecked(webRow);

  // Fast path: already in target state.
  const alreadyMatches =
    (wantLabel === 'research'   && researchOn && !webOn) ||
    (wantLabel === 'web search' && webOn      && !researchOn) ||
    (wantLabel === null         && !researchOn && !webOn);
  if (alreadyMatches) {
    await closeToolsPopover();
    return;
  }

  // Turn ON the desired tool (if any) and verify the flip. Click first so the popover stays
  // open while we verify — Base UI keeps the menu open after a checkbox-row click.
  if (wantLabel === 'research' && researchRow) {
    if (!researchOn) {
      researchRow.click();
      await waitFor(() => isRowChecked(findToolRow('research')), 800);
    }
  } else if (wantLabel === 'web search' && webRow) {
    if (!webOn) {
      webRow.click();
      await waitFor(() => isRowChecked(findToolRow('web search')), 800);
    }
  }

  // Turn OFF any tool that should NOT be on. The native rows can both be on simultaneously,
  // so we enforce single-tool by un-checking whichever isn't the target.
  if (wantLabel !== 'research' && researchOn) {
    const r = findToolRow('research');
    if (r && isRowChecked(r)) {
      r.click();
      await waitFor(() => !isRowChecked(findToolRow('research')), 800);
    }
  }
  if (wantLabel !== 'web search' && webOn) {
    const w = findToolRow('web search');
    if (w && isRowChecked(w)) {
      w.click();
      await waitFor(() => !isRowChecked(findToolRow('web search')), 800);
    }
  }

  await closeToolsPopover();
}

// ─── Use Style submenu (inside Tools popover) ────────────────────────────────────────────────
//
// Captured DOM (Tools popover open, "Use style" row inside):
//   <div role="menuitem" tabindex="-1" id="_r_ct_"
//        aria-expanded="false" aria-haspopup="menu" …>
//     … <span class="block truncate">Use style</span> …
//   </div>
// Hovering or clicking this row opens a submenu whose items are menuitemcheckbox rows
// (one per style: Normal / Learning / Concise / Explanatory / Formal / Pragmatic Analyst).
// Captured style row:
//   <div role="menuitemcheckbox" tabindex="-1" id="base-ui-_r_f7_"
//        aria-checked="true|false" data-checked="" | data-unchecked="" …>
//     … <span class="block truncate">Normal</span> …
//   </div>
// Only one style can be active at a time (the app enforces mutex even though the role is
// menuitemcheckbox). Clicking a different style auto-unchecks the previous one.

// Map Wrapperr style ids → Claude UI labels. The 'pragmatic-analyst' id maps to "Pragmatic
// Analyst" exactly — Claude renders both words. Other styles are single-word matches.
const STYLE_LABEL = {
  'normal':            'normal',
  'learning':          'learning',
  'concise':           'concise',
  'explanatory':       'explanatory',
  'formal':            'formal',
  'pragmatic-analyst': 'pragmatic analyst',
};

// Three ranked strategies for the Use Style submenu trigger inside the open Tools popover:
//   1. [role="menuitem"][aria-haspopup="menu"] whose text starts with "use style" — the
//      strongest match: exact role + submenu indicator + label prefix.
//   2. Any element with aria-haspopup="menu" whose text contains "use style" — fallback if
//      the menuitem role is dropped.
//   3. Any [id^="base-ui-"] whose text starts with "use style" — broadest, catches future
//      role refactors as long as the label survives.
function findStyleSubmenuTrigger() {
  const candidates = document.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]');
  for (const c of candidates) {
    const t = (c.textContent || '').trim().toLowerCase();
    if (t.startsWith('use style')) return c;
  }
  const popup = document.querySelectorAll('[aria-haspopup="menu"]');
  for (const c of popup) {
    const t = (c.textContent || '').trim().toLowerCase();
    if (t.includes('use style')) return c;
  }
  const baseUi = document.querySelectorAll('[id^="base-ui-"]');
  for (const c of baseUi) {
    const t = (c.textContent || '').trim().toLowerCase();
    if (t.startsWith('use style')) return c;
  }
  return null;
}

// openStyleSubmenu: opens the Tools popover, finds the Use Style row, then opens its
// submenu via popoverOpen (pointerdown). Waits for the trigger's aria-expanded=true. Returns
// true on success.
async function openStyleSubmenu() {
  const popOk = await openToolsPopover();
  if (!popOk) return false;
  // Submenu trigger may not be present immediately — wait briefly for the popover content
  // to render.
  const trigger = await waitFor(() => findStyleSubmenuTrigger(), 800);
  if (!trigger) return false;
  if (trigger.getAttribute('aria-expanded') === 'true') return true;
  popoverOpen(trigger);
  const opened = await waitFor(() => trigger.getAttribute('aria-expanded') === 'true', 1000);
  return Boolean(opened);
}

// Three ranked strategies for finding a style row inside the open submenu. `label` is
// matched as the exact text of the row (case-insensitive, trimmed). We use equality (not
// includes) because "Normal" would otherwise also match a hypothetical "Normal Formal" or
// the trigger row's own subtext if Claude adds one.
//   1. [role="menuitemcheckbox"] whose inner-span text equals the label — strongest, scoped
//      to the actual checkbox semantic.
//   2. [role="menuitemcheckbox"] whose textContent equals the label — fallback if the row
//      drops the inner <span class="block truncate"> wrapper.
//   3. [id^="base-ui-"] whose textContent equals the label — broadest, catches role
//      renames.
function findStyleRow(label) {
  const want = label.toLowerCase();
  // Strategy 1: scoped to inner truncate span.
  const checks = document.querySelectorAll('[role="menuitemcheckbox"]');
  for (const r of checks) {
    const span = r.querySelector('span.block.truncate, span.truncate');
    const t = (span?.textContent || '').trim().toLowerCase();
    if (t === want) return r;
  }
  // Strategy 2: text equality on the whole row.
  for (const r of checks) {
    const t = (r.textContent || '').trim().toLowerCase();
    if (t === want) return r;
  }
  // Strategy 3: Base UI id prefix, text equality.
  const baseUi = document.querySelectorAll('[id^="base-ui-"]');
  for (const r of baseUi) {
    const t = (r.textContent || '').trim().toLowerCase();
    if (t === want) return r;
  }
  return null;
}

// applyStyle: switch Claude's current style to the requested id. Skip silently when the id
// is unknown (e.g. spec drift) — log so we notice. Closes the popover on the way out.
async function applyStyle(styleId) {
  const wantLabel = STYLE_LABEL[styleId];
  if (!wantLabel) {
    console.warn('[wrapperr] Claude unknown style id:', styleId);
    return;
  }

  const opened = await openStyleSubmenu();
  if (!opened) {
    console.warn('[wrapperr] Claude Use Style submenu did not open — sending without applying style');
    await closeToolsPopover();
    return;
  }

  const target = findStyleRow(wantLabel);
  if (!target) {
    console.warn(`[wrapperr] Claude style "${wantLabel}" row not found — sending with current style`);
    await closeToolsPopover();
    return;
  }

  // Fast path: already checked.
  if (isRowChecked(target)) {
    await closeToolsPopover();
    return;
  }

  target.click();
  // Wait for either the row to flip OR the popover to close (Claude closes the menu after
  // a style selection on some versions). Either is success.
  await waitFor(() => {
    const fresh = findStyleRow(wantLabel);
    if (fresh && isRowChecked(fresh)) return true;
    const trig = findToolsTrigger();
    return trig && trig.getAttribute('aria-expanded') !== 'true';
  }, 1000);

  await closeToolsPopover();
}

// ─── Model picker (Opus 4.8 / Sonnet 4.6 / Haiku 4.5) ────────────────────────────────────────
//
// Captured DOM (closed):
//   <button class="…" type="button" data-testid="model-selector-dropdown"
//           aria-label="Model: Haiku 4.5" tabindex="0"
//           aria-haspopup="menu" aria-expanded="false" id="_r_ab_">
// The trigger's aria-label is the cheapest source of truth for the current model.
//
// Captured rows (one per model):
//   <div role="menuitemradio" tabindex="-1" id="base-ui-_r_h7_"
//        aria-checked="true|false" …>
//     <span class="flex min-w-0 flex-1 flex-col">
//       <span class="truncate"><span class="font-ui">Haiku 4.5</span></span>
//       <span class="truncate text-footnote text-muted">Fastest for quick answers</span>
//     </span>
//   </div>
// The row's textContent is "{Model label}{tagline}" — we MUST match against the inner
// <span class="font-ui"> to avoid false positives on the tagline.

const MODEL_LABEL = {
  'opus-4-8':   'opus 4.8',
  'sonnet-4-6': 'sonnet 4.6',
  'haiku-4-5':  'haiku 4.5',
};

// KNOWN_MODEL_LABELS — used by findModelTrigger's strategy-3 fuzzy fallback. Includes both
// the full versioned labels and the bare family names so we still hit on an account where
// Claude has rolled out a newer point release (e.g. "Haiku 4.6") before we update.
const KNOWN_MODEL_LABELS = ['opus 4.8', 'sonnet 4.6', 'haiku 4.5', 'opus', 'sonnet', 'haiku'];

// Three ranked strategies for the model trigger (best→worst):
//   1. [data-testid="model-selector-dropdown"] — the single most stable hook on the whole
//      composer. testids change less often than aria-labels (aria-labels include the model
//      name, which churns every release).
//   2. button[aria-label^="Model:"] — aria-label prefix is stable across model renames.
//   3. Any button[aria-haspopup="menu"] near the composer textarea whose visible text
//      contains a known model family name. Broadest; risks matching a model name in chat
//      history, mitigated by preferring the element closest to the input.
function findModelTrigger() {
  const t1 = document.querySelector('[data-testid="model-selector-dropdown"]');
  if (t1) return t1;
  const t2 = document.querySelector('button[aria-label^="Model:"]');
  if (t2) return t2;
  // Strategy 3 — pick the closest model-named button to the composer.
  const all = Array.from(document.querySelectorAll('button[aria-haspopup="menu"], button')).filter((b) => {
    const t = (b.textContent || '').trim().toLowerCase();
    return KNOWN_MODEL_LABELS.some((m) => t.includes(m));
  });
  if (all.length === 0) return null;
  const input = document.querySelector('div[contenteditable="true"][data-testid="chat-input"]')
    ?? document.querySelector('div[contenteditable="true"]');
  if (!input) return all[0];
  const ir = input.getBoundingClientRect();
  all.sort((a, b) => {
    const ar = a.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    return Math.hypot(ar.left - ir.left, ar.top - ir.top) - Math.hypot(br.left - ir.left, br.top - ir.top);
  });
  return all[0];
}

// getCurrentModelLabel: cheap fast-path detector. Reads aria-label first ("Model: Haiku 4.5"
// → "haiku 4.5") then falls back to trigger textContent. Returns null when no trigger found.
function getCurrentModelLabel() {
  const trigger = findModelTrigger();
  if (!trigger) return null;
  const aria = trigger.getAttribute('aria-label') || '';
  const m = aria.match(/^Model:\s*(.+)$/i);
  if (m) return m[1].trim().toLowerCase();
  return (trigger.textContent || '').trim().toLowerCase();
}

// Three ranked strategies for a model menu row (best→worst):
//   1. [role="menuitemradio"] containing a <span class="font-ui"> whose text equals the
//      label — the strongest match: exact role, exact label span, exact text. The font-ui
//      span exists specifically for the model name and excludes the tagline.
//   2. [role="menuitemradio"] whose textContent starts with the label — fallback if the
//      font-ui span is removed; startsWith avoids matching the tagline beneath.
//   3. [id^="base-ui-"] whose textContent starts with the label — broadest, role-rename
//      tolerant.
function findModelRow(label) {
  const want = label.toLowerCase();
  // Strategy 1: font-ui span text equality, scoped to menuitemradio rows.
  const radios = document.querySelectorAll('[role="menuitemradio"]');
  for (const r of radios) {
    const span = r.querySelector('span.font-ui');
    const t = (span?.textContent || '').trim().toLowerCase();
    if (t === want) return r;
  }
  // Strategy 2: row textContent prefix match.
  for (const r of radios) {
    const t = (r.textContent || '').trim().toLowerCase();
    if (t === want || t.startsWith(want)) return r;
  }
  // Strategy 3: Base UI id prefix, text prefix match.
  const baseUi = document.querySelectorAll('[id^="base-ui-"]');
  for (const r of baseUi) {
    const t = (r.textContent || '').trim().toLowerCase();
    if (t === want || t.startsWith(want)) return r;
  }
  return null;
}

// applyModelIntelligence: switch the model picker to the requested label. Fast-path on
// aria-label match. Otherwise open the picker, click the target row, wait for the trigger
// label to update, close the menu defensively (Escape) if it didn't auto-close on select.
async function applyModelIntelligence(intelligence) {
  const wantLabel = MODEL_LABEL[intelligence];
  if (!wantLabel) return; // unknown id → leave model alone

  const current = getCurrentModelLabel();
  if (current && current.includes(wantLabel)) return; // already there — fast path

  const trigger = findModelTrigger();
  if (!trigger) {
    console.warn('[wrapperr] Claude model picker not found — sending with current model');
    return;
  }

  if (trigger.getAttribute('aria-expanded') !== 'true') {
    popoverOpen(trigger);
    const opened = await waitFor(() => trigger.getAttribute('aria-expanded') === 'true', 1500);
    if (!opened) {
      console.warn('[wrapperr] Claude model picker did not open — sending with current model');
      return;
    }
  }

  const item = await waitFor(() => findModelRow(wantLabel), 1000);
  if (!item) {
    console.warn(`[wrapperr] Claude model "${wantLabel}" row not found — sending with current model`);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return;
  }
  item.click();

  // Wait for the trigger aria-label OR text to reflect the new model, OR for the menu to
  // close (Base UI closes on selection by default for radio rows).
  await waitFor(() => {
    const cur = getCurrentModelLabel();
    if (cur && cur.includes(wantLabel)) return true;
    const fresh = findModelTrigger();
    return fresh && fresh.getAttribute('aria-expanded') !== 'true';
  }, 1000);

  // Belt-and-braces: if the menu is still open after the selection, close it so the
  // upcoming send-button click can't land inside AND the user doesn't see a stranded open
  // model picker on their next visit to the claude.ai tab. dismissOpenMenu first
  // (outside-click on document.body, the only thing Base UI's portal menu listens to),
  // Escape fallback if that didn't take.
  const finalTrigger = findModelTrigger();
  if (finalTrigger && finalTrigger.getAttribute('aria-expanded') === 'true') {
    dismissOpenMenu();
    const closed = await waitFor(() => {
      const t = findModelTrigger();
      return !t || t.getAttribute('aria-expanded') !== 'true';
    }, 400);
    if (!closed) {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await sleep(100);
    }
  }
}

// Message listener — guarded against double-installation if the script is re-injected.
// Same shape as gemini.js / chatgpt.js / grok.js / deepseek.js: WRAPPERR_INJECT_ONLY captures
// baseline + applies options + injects, WRAPPERR_GET_STATE returns the current best response
// text for the SW's stability poller, WRAPPERR_REREAD_LATEST returns the latest assistant
// reply for Compare's per-slide recheck.
if (!window.__wrapperrAIListenerOn) {
  window.__wrapperrAIListenerOn = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'WRAPPERR_INJECT_ONLY') {
      (async () => {
        try {
          // Baseline first so applyOptions' DOM activity (opening menus, clicking toggles)
          // can't pollute the assistant-message count. applyOptions never injects assistant
          // nodes, but this ordering is defensive and matches chatgpt.js.
          const baseline = getBaseline();
          // applyOptions is best-effort: even on internal failure it returns without
          // throwing, so injection always runs. msg.options is undefined for legacy callers
          // (Compare's per-AI fan-out) — applyOptions is a no-op in that case.
          await applyOptions(msg.options || {});
          await injectMessage(msg.message);
          sendResponse({ ok: true, baseline });
        } catch (err) {
          sendResponse({ ok: false, error: toWrapperrError(err, 'AI_INJECT_INPUT_NOT_FOUND', { ai: 'claude', requestId: msg.requestId }) });
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

} // end load guard
