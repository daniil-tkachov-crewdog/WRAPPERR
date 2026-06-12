// injectMessage: locate Gemini's rich-textarea / .ql-editor composer and submit.
//
// All actual typing logic lives in _wrapperr-input.js so any AI can reuse it and future input
// kinds (voice, file attachments) get implemented once instead of per-AI. We just find the
// element here and click the send button after the input layer settles.
async function injectMessage(message) {
  const input = document.querySelector('rich-textarea .ql-editor')
    ?? document.querySelector('div[contenteditable="true"].ql-editor')
    ?? document.querySelector('[contenteditable="true"][data-placeholder]')
    ?? document.querySelector('[contenteditable="true"]');
  if (!input) throw wrapperrError('AI_INJECT_INPUT_NOT_FOUND', { ai: 'gemini', details: { url: location.href, selectorsTried: ['rich-textarea .ql-editor', 'div[contenteditable="true"].ql-editor', '[contenteditable="true"][data-placeholder]', '[contenteditable="true"]'] } });

  await wrapperrInjectInput(input, { kind: 'text', text: message });

  const sendBtn = document.querySelector('button[aria-label="Send message"]')
    ?? document.querySelector('button.send-button')
    ?? [...document.querySelectorAll('button')].find(
        (b) => b.getAttribute('aria-label')?.toLowerCase().includes('send')
      );

  if (sendBtn && !sendBtn.disabled) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

const RESPONSE_SELECTOR = '.model-response-text, [class*="model-response"], .response-container';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/gemini-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and expose
// the global readBestGeminiText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// Gemini's DOM renders markdown as HTML; innerText on the rendered DOM produces plain text
// with no markdown symbols. If we fall back to DOM before the wrb.fr chunks arrive in the
// network buffer, the SW receives plain text, calls it stable, and returns it — dropping all
// formatting. We delay DOM fallback by 3 s to give the network buffer time to fill.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestGeminiText(sentAt);
  if (netText) {
    window.__wrapperrGeminiDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrGeminiDomGrace) window.__wrapperrGeminiDomGrace = now;
  if (now - window.__wrapperrGeminiDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// readLatestResponse: see chatgpt.js. Network buffer preferred (Gemini's DOM strips markdown);
// DOM fallback uses the same RESPONSE_SELECTOR as getBaseline.
function readLatestResponse() {
  const netText = readBestGeminiText(0);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const last = messages[messages.length - 1];
  return last ? wrapperrBestText(last) : '';
}

// ─── applyOptions helpers ────────────────────────────────────────────────────────────────────

// withTimeout: race a promise against a timer. Enforces the per-action time budget without
// AbortController plumbing through every helper. The rejection is caught by the orchestrator's
// try/catch and the send proceeds — a slow Gemini menu eats into the apply budget, never into
// the send itself. Same pattern as chatgpt.js / claude.js / grok.js.
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
// on timeout. Used wherever we expect a DOM mutation (menu portal populates, trigger label
// updates, chip appears). Predicate errors are swallowed so a one-off null deref during a
// Material open/close animation doesn't kill the wait. Mirrors grok.js::waitFor.
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

// norm: canonicalise label text for comparison. Gemini's Angular templates pad label nodes
// with whitespace (captured DOM literally contains " Deep Research " / " 3.1 Flash-Lite "
// inside the label spans), so equality checks without trim/collapse would fail on every row.
function norm(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

// isVisible: cheap visibility check used to skip hidden/zero-size matches. Angular CDK
// destroys closed-menu portals entirely, so this mostly guards against display:none templates
// and detached placeholder nodes that share the same selectors.
function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// overlayRoot: Angular Material (CDK) renders menu portals into <div class="cdk-overlay-container">,
// BUT Gemini's <gem-menu> wrapper attaches some menus (model picker confirmed) directly to body
// instead — outside the cdk container. Diagnostic run 2026-06: opening the model picker shows
// cdk-overlay-container present but empty; the gem-menu-item rows live elsewhere in the doc.
// We therefore prefer cdk-overlay-container ONLY when it has content; otherwise the row finders
// fall back to scanning the whole document, relying on isVisible() to filter out collapsed/
// hidden menu fragments.
function overlayRoot() {
  const c = document.querySelector('.cdk-overlay-container');
  if (c && c.querySelector('*')) return c;
  return null;
}

// MENU_ANIMATION_MS: Material menus animate open over ~150 ms; querying for rows immediately
// after the trigger click finds an empty portal. Every open/click step pauses this long before
// the first query (waitFor's polling then covers the remainder of the wait).
const MENU_ANIMATION_MS = 200;

// closeOverlays: dismiss any open Material menu so it doesn't hover over the composer when we
// hand off to injectMessage. Three ranked strategies (best→worst):
//   1. Click the CDK backdrop (.cdk-overlay-backdrop) — Material's own click-away surface,
//      present whenever a menu is open and guaranteed to close it.
//   2. Dispatch Escape on document.body — Material menus subscribe via the CDK keyboard
//      dispatcher.
//   3. Give up silently after 3 rounds — a stuck-open menu is cosmetic; injectMessage
//      re-focuses the composer and the send still works.
// Loops up to 3× because a submenu (More tools) plus its parent menu can need two dismissals.
async function closeOverlays() {
  for (let i = 0; i < 3; i++) {
    const backdrop = document.querySelector('.cdk-overlay-backdrop');
    const hasPanels = overlayRoot()?.querySelector('.cdk-overlay-pane *');
    if (!backdrop && !hasPanels) return;
    if (backdrop) backdrop.click();
    else document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await sleep(MENU_ANIMATION_MS);
  }
}

// ─── Tools menu (feature slot: Deep Research / Guided Learning) ──────────────────────────────
//
// Captured DOM from gemini.google.com (logged-in, fresh chat, 2026-06):
//   • "+" trigger: <button mat-icon-button aria-label="Upload and tools" aria-haspopup="menu"
//     aria-expanded="false"> wrapping <mat-icon data-mat-icon-name="plus">.
//   • Top-level menu rows: Upload files / Add from Drive / More uploads / Create image /
//     Canvas / More tools — label text lives in div.gem-menu-item-label (feature rows) or
//     div.menu-text (upload rows).
//   • Deep Research / Create music / Guided Learning live in a SUBMENU behind "More tools".
//   • Toggle rows are <button role="menuitemcheckbox" aria-checked="false|true"> — aria-checked
//     is the authoritative on/off state and is language-independent.

// findToolsTrigger: locate the "+" button that opens the upload/tools menu. Three ranked
// strategies (best→worst), per the project's 3-fallbacks rule — Gemini's hashed Angular class
// names churn every deploy, so each rung uses a different anchor:
//   1. button[aria-label="Upload and tools"] — exact accessibility label; screen-reader
//      tooling depends on it so it churns slowly. Breaks on copy reword/localisation.
//   2. A menu-opener button whose mat-icon is the "plus" glyph — survives a label rewording
//      as long as the icon name stays "plus".
//   3. Structural: walk up from <rich-textarea> (the composer custom element) and take the
//      first visible button[aria-haspopup="menu"] in each ancestor — survives label AND icon
//      changes as long as the trigger stays a menu opener near the composer.
function findToolsTrigger() {
  const exact = document.querySelector('button[aria-label="Upload and tools"]');
  if (exact && isVisible(exact)) return exact;

  for (const b of document.querySelectorAll('button[aria-haspopup="menu"]')) {
    if (b.querySelector('mat-icon[data-mat-icon-name="plus"], mat-icon[fonticon="plus"]') && isVisible(b)) return b;
  }

  let scope = document.querySelector('rich-textarea');
  for (let i = 0; i < 6 && scope; i++) {
    const b = scope.querySelector?.('button[aria-haspopup="menu"]');
    if (b && isVisible(b)) return b;
    scope = scope.parentElement;
  }
  return null;
}

// openToolsMenu: click the "+" trigger and wait for the menu portal to populate. Idempotent —
// skips the click when the trigger already reports aria-expanded="true". Success criterion is
// a visible row appearing in the overlay, NOT the aria attribute alone, because Material flips
// aria-expanded before the panel children exist (the ~150 ms open animation).
async function openToolsMenu() {
  const trigger = findToolsTrigger();
  if (!trigger) return false;
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  await sleep(MENU_ANIMATION_MS);
  // Search whole document — see overlayRoot() comment re: <gem-menu> portals attached outside
  // cdk-overlay-container. isVisible filter on the row finder handles closed-menu artifacts.
  const populated = await waitFor(() => {
    return [...document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [mat-list-item], gem-menu-item-content')]
      .find(isVisible);
  }, 1500);
  return !!populated;
}

// findOverlayRow: find the clickable menu row whose label equals `label`, anywhere in the
// document. Shared by the Tools flow and the model finder's last resort. Three ranked
// strategies (best→worst):
//   1. Menu-item-role elements (menuitem / menuitemcheckbox / menuitemradio / option) matched
//      on their dedicated label node — matches the captured DOM where toggle rows are
//      <button role="menuitemcheckbox">.
//   2. Gemini's label nodes (.gem-menu-item-label / .menu-text) matched by exact text, then
//      climbed to the closest clickable ancestor — survives a role refactor.
//   3. Brute scan of clickable elements for text containment — last resort, restricted to
//      clickable tags only so we never "click" a plain wrapper div with no handler bound.
// Why whole-document scope (not just overlay container)? Diagnostic 2026-06 showed Gemini's
// <gem-menu> portals can sit outside .cdk-overlay-container — searching only the container
// misses every model row. The isVisible() guard prevents collapsed/detached menu fragments
// from matching. Matching detail: rows append badges ("New") and tooltips to their full
// textContent, so when a dedicated label node exists we require exact equality on it; only
// the rung-3 brute scan uses `includes`, accepting false-positive risk for survivability.
function findOverlayRow(label) {
  const want = norm(label);
  if (!want) return null;

  for (const r of document.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"]')) {
    if (!isVisible(r)) continue;
    const lblNode = r.querySelector('.gem-menu-item-label, .menu-text, .label');
    const text = norm(lblNode ? lblNode.textContent : r.textContent);
    if (lblNode ? text === want : text.includes(want)) return r;
  }

  for (const n of document.querySelectorAll('.gem-menu-item-label, .menu-text, span.label')) {
    if (norm(n.textContent) !== want) continue;
    const row = n.closest('button, [mat-list-item], [role^="menuitem"], [role="option"], gem-menu-item');
    if (row && isVisible(row)) return row;
  }

  for (const el of document.querySelectorAll('button, [role="button"], [mat-list-item], gem-menu-item')) {
    if (norm(el.textContent).includes(want) && isVisible(el)) return el;
  }
  return null;
}

// revealFeatureRow: make sure a tools row (Deep Research / Guided Learning) is present in the
// open overlay. As of 2026-06 both live behind the "More tools" submenu of the "+" menu, but
// some tiers / future deploys may surface them at top level — so we look for the row first and
// only expand "More tools" when it's missing. Submenus are CDK portals too: the parent menu
// stays in the overlay alongside the child panel, so findOverlayRow keeps seeing both.
async function revealFeatureRow(label) {
  let row = findOverlayRow(label);
  if (row) return row;
  const more = findOverlayRow('More tools');
  if (more) {
    more.click();
    await sleep(MENU_ANIMATION_MS);
    row = await waitFor(() => findOverlayRow(label), 1500);
  }
  return row;
}

// rowChecked: read a toggle row's on/off state. Captured rows are role="menuitemcheckbox"
// with aria-checked="true|false" — authoritative and language-independent. A row carrying no
// aria-checked (role refactor) returns null = "unknown"; the caller clicks unknown-state rows
// only when turning ON, never OFF — clicking an unknown row to turn it off could accidentally
// turn it ON instead.
function rowChecked(row) {
  const v = row?.getAttribute?.('aria-checked');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

// activeToolChip: detect an already-active tool WITHOUT opening any menu. When a tool like
// Deep Research is active, Gemini shows a labelled chip in the composer area. We scan visible
// clickable elements OUTSIDE the overlay portal for an exact label match. Heuristic only: it
// short-circuits the menu dance and verifies clicks; the menu row's aria-checked stays the
// authority whenever the menu is open. False negatives are safe (we just open the menu and
// check); false positives are unlikely because matching is exact-text on clickable elements.
function activeToolChip(label) {
  const want = norm(label);
  for (const el of document.querySelectorAll('button, [role="button"]')) {
    if (el.closest('.cdk-overlay-container')) continue;
    if (norm(el.textContent) === want && isVisible(el)) return el;
  }
  return null;
}

// setToolToggle: drive one tools checkbox (Deep Research / Guided Learning) to wantOn.
// Flow: chip short-circuit → open "+" menu → reveal row (expanding the More tools submenu) →
// read aria-checked → click only on mismatch (so a no-op never flips OFF something the user
// turned ON manually) → verify → close overlays. A row click may auto-close the menu depending
// on deploy, so verification accepts EITHER the composer chip or the re-queried row state.
// KNOWN LIMIT: the "already off" short-circuit trusts chip absence without opening the menu —
// opening the "+" menu on every optionless send would be intrusive. If Gemini ever stops
// rendering chips for active tools, the off-path could miss a stale ON state.
// Throws on hard failure; the orchestrator catches, warns, and the send proceeds.
async function setToolToggle(label, wantOn) {
  const chip = activeToolChip(label);
  if (wantOn && chip) return;
  if (!wantOn && !chip) return;

  if (!(await openToolsMenu())) throw new Error('could not open Gemini tools menu');
  const row = await revealFeatureRow(label);
  if (!row) {
    await closeOverlays();
    throw new Error(`tools row "${label}" not found in open menu`);
  }

  const checked = rowChecked(row);
  const needsClick = wantOn ? checked !== true : checked === true;
  if (needsClick) {
    row.click();
    await sleep(MENU_ANIMATION_MS);
  }

  const ok = await waitFor(() => {
    if (wantOn) return !!activeToolChip(label) || rowChecked(findOverlayRow(label)) === true;
    return !activeToolChip(label) && rowChecked(findOverlayRow(label)) !== true;
  }, 2000);

  await closeOverlays();
  if (!ok) throw new Error(`could not set "${label}" to ${wantOn ? 'on' : 'off'}`);
}

// GEMINI_TOOL_LABELS / SOON_FEATURE_IDS: Wrapperr feature ids → Gemini's visible row labels.
// The four coming-soon ids are blocked in the web UI (InputBar renders them disabled and
// unselectable) but we defensively no-op + warn here in case a stale client or future UI bug
// lets one through. Keep both in sync with web/lib/aiFeatures.ts gemini.feature.options.
const GEMINI_TOOL_LABELS = { 'deep-research': 'Deep Research', 'guided-learning': 'Guided Learning' };
const SOON_FEATURE_IDS = ['add-from-drive', 'create-image', 'canvas', 'create-music'];

// applyFeature: reconcile the Tools slot with single-select semantics matching the web pill:
//   undefined         → both toggles OFF (pill cleared = no tool active)
//   'deep-research'   → Deep Research ON, Guided Learning OFF
//   'guided-learning' → Guided Learning ON, Deep Research OFF
// Order matters: the unwanted tool is turned OFF before the wanted one is turned ON — Gemini
// may treat the two as mutually exclusive and auto-disable one when enabling the other;
// off-first avoids fighting that and avoids a transient double-ON state.
async function applyFeature(featureId) {
  if (SOON_FEATURE_IDS.includes(featureId)) {
    console.warn(`[wrapperr] gemini: feature "${featureId}" is coming-soon, ignoring`);
    return;
  }
  if (featureId !== undefined && !GEMINI_TOOL_LABELS[featureId]) {
    console.warn(`[wrapperr] gemini: unknown feature "${featureId}", ignoring`);
    return;
  }
  for (const [id, label] of Object.entries(GEMINI_TOOL_LABELS)) {
    if (id !== featureId) await setToolToggle(label, false);
  }
  if (featureId) await setToolToggle(GEMINI_TOOL_LABELS[featureId], true);
}

// ─── Model picker (intelligence slot) ────────────────────────────────────────────────────────
//
// Captured DOM from gemini.google.com (2026-06):
//   • Trigger: <button mat-button data-test-id="bard-mode-menu-button"
//     aria-label="Open mode picker, currently Flash" aria-haspopup="true"> containing
//     <span class="picker-primary-text">Flash</span>.
//     NOTE: the trigger shows the SHORT model name ("Flash-Lite" / "Flash" / "Pro") while menu
//     rows show the full label ("3.1 Flash-Lite" / "3.5 Flash" / "3.1 Pro") — matching and
//     verification must bridge the two forms, see shortLabel().
//   • Row content: <gem-menu-item-content> with <span class="label"> 3.1 Flash-Lite </span>
//     plus a sublabel ("Fastest answers"). The selected row carries class "selected" and a
//     check icon. The rows' clickable WRAPPER could not be captured (DevTools folded the
//     menu), so finders climb from gem-menu-item-content to the closest clickable ancestor
//     and fall back to clicking the content element itself (the click bubbles to Angular's
//     handler either way).
//   • The same menu hosts a "Thinking level" submenu (Standard / Extended) — out of scope this
//     session; exact-label matching never collides with it.

// MODEL_LABELS: Wrapperr intelligence ids → Gemini's full row labels. 'flash-light' keeps its
// historical id (persisted in users' localStorage under wrapperr:aiOptions:v1) even though the
// visible label was corrected to "Flash-Lite" — renaming the id would orphan saved selections.
// Keep in sync with web/lib/aiFeatures.ts gemini.intelligence.options.
const MODEL_LABELS = { 'flash-light': '3.1 Flash-Lite', 'flash': '3.5 Flash', 'pro': '3.1 Pro' };

// shortLabel: derive the trigger's short display form from a full row label by stripping the
// leading version number ("3.1 Flash-Lite" → "Flash-Lite"). Callers also accept full-label
// equality, so this keeps working if Gemini ever shows full labels on the trigger too.
function shortLabel(full) { return full.replace(/^\d+(\.\d+)*\s*/, ''); }

// findModelTrigger: locate the model-picker button (shows the current model next to the
// composer). Three ranked strategies (best→worst):
//   1. button[data-test-id="bard-mode-menu-button"] — Google's own test hook; test ids churn
//      far slower than classes or copy.
//   2. A button whose aria-label starts with "Open mode picker" — survives a test-id rename
//      but is English-copy-fragile, hence rank 2.
//   3. Structural: the button containing span.picker-primary-text, else any popup-opener
//      button whose entire text equals one of the known short model names.
function findModelTrigger() {
  const byTestId = document.querySelector('button[data-test-id="bard-mode-menu-button"]');
  if (byTestId && isVisible(byTestId)) return byTestId;

  for (const b of document.querySelectorAll('button[aria-label]')) {
    if ((b.getAttribute('aria-label') || '').toLowerCase().startsWith('open mode picker') && isVisible(b)) return b;
  }

  const span = document.querySelector('button span.picker-primary-text');
  if (span) {
    const b = span.closest('button');
    if (b && isVisible(b)) return b;
  }
  const shorts = Object.values(MODEL_LABELS).map((l) => norm(shortLabel(l)));
  for (const b of document.querySelectorAll('button[aria-haspopup]')) {
    if (shorts.includes(norm(b.textContent)) && isVisible(b)) return b;
  }
  return null;
}

// getCurrentModelShort: read the currently selected model's short name from the trigger. Used
// to short-circuit when the requested model is already active and to verify the click landed.
// Three ranked strategies (best→worst):
//   1. span.picker-primary-text textContent — the dedicated label node per captured DOM.
//   2. Parse the trigger's aria-label ("Open mode picker, currently Flash") — rank 2 because
//      the word "currently" is English copy and breaks under localisation.
//   3. Scan the trigger's whole text against the known short names — exact match first, then
//      containment ordered longest-first so "Flash" can never shadow "Flash-Lite".
function getCurrentModelShort() {
  const trigger = findModelTrigger();
  if (!trigger) return null;

  const span = trigger.querySelector('span.picker-primary-text');
  if (span && norm(span.textContent)) return span.textContent.trim();

  const m = (trigger.getAttribute('aria-label') || '').match(/currently\s+(.+)$/i);
  if (m) return m[1].trim();

  const text = norm(trigger.textContent);
  const shorts = Object.values(MODEL_LABELS).map(shortLabel).sort((a, b) => b.length - a.length);
  for (const s of shorts) if (text === norm(s)) return s;
  for (const s of shorts) if (text.includes(norm(s))) return s;
  return null;
}

// openModelMenu: open the mode-picker dropdown; idempotent via aria-expanded. Like
// openToolsMenu, success is "model row content exists in the overlay", not the aria attribute
// alone, because of the Material open animation.
async function openModelMenu() {
  const trigger = findModelTrigger();
  if (!trigger) return false;
  if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
  await sleep(MENU_ANIMATION_MS);
  // Whole-document scope — Gemini's <gem-menu> for the model picker attaches outside
  // .cdk-overlay-container (verified by diagnostic). isVisible guards stale rows.
  const populated = await waitFor(() => {
    return [...document.querySelectorAll('gem-menu-item-content, gem-menu-item, [role="menuitemradio"], [role="menuitem"]')]
      .find(isVisible);
  }, 1500);
  return !!populated;
}

// findModelRow: find the clickable row for a model anywhere in the document. Three ranked
// strategies (best→worst):
//   1. gem-menu-item-content whose span.label equals the full label → climb to the closest
//      clickable wrapper (<gem-menu-item> per diagnostic, role="menuitem"); fall back to the
//      content element itself (click still bubbles).
//   2. Role-based: any menu-item-role element whose label node matches — survives the
//      <gem-menu-item-content> custom element being renamed.
//   3. findOverlayRow's generic ladder (label-node walk + brute scan) as last resort.
// Exact equality on the dedicated label node matters: "3.5 Flash" must never match the
// "3.1 Flash-Lite" row or the "Thinking level" group via substring containment.
function findModelRow(fullLabel) {
  const want = norm(fullLabel);

  for (const c of document.querySelectorAll('gem-menu-item-content')) {
    const lbl = c.querySelector('span.label, .label');
    if (!lbl || norm(lbl.textContent) !== want) continue;
    if (!isVisible(c)) continue;
    return c.closest('gem-menu-item, button, [role="menuitem"], [role="menuitemradio"], [role="option"], [mat-list-item]') || c;
  }

  for (const r of document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"]')) {
    if (!isVisible(r)) continue;
    const lbl = r.querySelector('span.label, .label, .gem-menu-item-label');
    if (lbl && norm(lbl.textContent) === want) return r;
  }

  return findOverlayRow(fullLabel);
}

// applyIntelligence: switch Gemini to the requested model. undefined → leave the picker
// untouched (Model pill unset means "whatever the site already has"). Flow mirrors grok.js:
// short-circuit on current state → open menu → click row → verify the trigger label updated →
// close overlays. Tier-locked models (e.g. Pro without a subscription) render disabled rows:
// the click no-ops, verification fails, the orchestrator warns, and the send continues on the
// old model — matching the project's "never block the send" contract.
async function applyIntelligence(modelId) {
  if (modelId === undefined) return;
  const fullLabel = MODEL_LABELS[modelId];
  if (!fullLabel) {
    console.warn(`[wrapperr] gemini: unknown model "${modelId}", ignoring`);
    return;
  }

  const targetShort = shortLabel(fullLabel);
  const current = getCurrentModelShort();
  if (current && (norm(current) === norm(targetShort) || norm(current) === norm(fullLabel))) return;

  if (!(await openModelMenu())) throw new Error('could not open Gemini model menu');

  const row = findModelRow(fullLabel);
  if (!row) {
    await closeOverlays();
    throw new Error(`model row "${fullLabel}" not found in open menu`);
  }

  row.click();

  const ok = await waitFor(() => {
    const c = getCurrentModelShort();
    return c && (norm(c) === norm(targetShort) || norm(c) === norm(fullLabel));
  }, 2000);

  await closeOverlays();
  if (!ok) throw new Error(`model did not switch to "${fullLabel}" after click`);
}

// ─── applyOptions orchestrator ───────────────────────────────────────────────────────────────

// applyOptions: best-effort apply Gemini's Tools + Model to match the user's Wrapperr pill
// selections BEFORE injecting the prompt. Shape:
//   { feature?: 'deep-research'|'guided-learning'|<soon id>, intelligence?: 'flash-light'|'flash'|'pro' }
// Hard contract: MUST NOT throw. Each slot is independently try/catch-wrapped with a time
// budget; on failure we console.warn and fall through to injectMessage — better to send the
// prompt without the toggle than to abort entirely. gemini.google.com's hashed Angular class
// names churn every deploy, so selector breakage here is expected, not exceptional.
// When BOTH slots are undefined (user picked nothing) we return without touching the page at
// all — backwards-compat with the pre-options send flow.
async function applyOptions(options) {
  if (!options || typeof options !== 'object') return;
  const hasAny = options.feature !== undefined || options.intelligence !== undefined;
  if (!hasAny) return;

  const TOTAL_BUDGET_MS = 12000;
  const PER_ACTION_MS = 6000;
  const start = Date.now();
  const remaining = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - start));

  // Tools slot — runs even when options.feature is undefined (that means "pill cleared",
  // which must turn OFF a previously enabled tool). The chip short-circuit inside
  // setToolToggle keeps the everything-already-off path free of any menu opening.
  try {
    if (remaining() > 0) {
      await withTimeout(applyFeature(options.feature), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] Gemini applyFeature failed, sending without it:', err && err.message || err);
  }

  // Model slot — undefined leaves the picker untouched (no "default model" concept in the UI).
  try {
    if (remaining() > 0) {
      await withTimeout(applyIntelligence(options.intelligence), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] Gemini applyIntelligence failed, sending without it:', err && err.message || err);
  }
}

if (!window.__wrapperrAIListenerOn) {
  window.__wrapperrAIListenerOn = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'WRAPPERR_INJECT_ONLY') {
      (async () => {
        try {
          const baseline = getBaseline();
          // applyOptions is best-effort and catches its own failures internally — a broken
          // Gemini selector must never block the send (see the applyOptions block above).
          await applyOptions(msg.options || {});
          await injectMessage(msg.message);
          sendResponse({ ok: true, baseline });
        } catch (err) {
          sendResponse({ ok: false, error: toWrapperrError(err, 'AI_INJECT_INPUT_NOT_FOUND', { ai: 'gemini', requestId: msg.requestId }) });
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
