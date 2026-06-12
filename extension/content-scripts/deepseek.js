// injectMessage: locate DeepSeek's textarea composer and submit.
//
// All actual typing logic lives in _wrapperr-input.js (native-field strategy via the React
// prototype setter, auto-selected because the composer is a <textarea>). Plain `el.value = ...`
// is silently ignored by React-controlled inputs, which is why earlier versions of this file had
// the send button stay disabled — the helper handles that correctly in one place for every AI.
async function injectMessage(message) {
  // Locate the composer. DeepSeek uses a plain <textarea> with placeholder="Message DSeek" and
  // name="search". Hashed classes (_27c9245, d96f2d2a, …) change across builds so we don't rely
  // on them. Fallbacks cover the case where DeepSeek tweaks the placeholder copy.
  const input = document.querySelector('textarea[placeholder="Message DSeek"]')
    ?? document.querySelector('textarea[name="search"]')
    ?? document.querySelector('textarea[placeholder*="DSeek"]')
    ?? document.querySelector('textarea[placeholder*="Message"]')
    ?? document.querySelector('textarea');
  if (!input) throw new Error('DeepSeek input not found');

  await wrapperrInjectInput(input, { kind: 'text', text: message });

  // Send button is a <div role="button"> (not a real <button>), so document.querySelectorAll
  // ('button') misses it — that's why we filter by role. The ds-button--primary class marks the
  // send button specifically; ds-button--disabled flips off once the textarea has text. We pick
  // the first matching enabled candidate. Enter-keydown fallback exists in case React's onClick
  // handler ignores a synthetic .click() on a <div>.
  const sendBtn = [...document.querySelectorAll('div[role="button"].ds-button--primary')]
    .find((b) => !b.classList.contains('ds-button--disabled'));

  if (sendBtn) {
    sendBtn.click();
  } else {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  }
}

// DOM-scrape fallback selector — last resort only. DeepSeek renders Markdown as HTML, so reading
// innerText here loses formatting symbols (#, **, fence ticks). The grace window in
// getCurrentState exists precisely to avoid hitting this path while the network buffer is still
// filling.
const RESPONSE_SELECTOR =
  '[class*="ds-markdown"], [class*="message-content"], [class*="assistant"], [class*="ds-message-row"]:not([class*="user"])';

function getBaseline() {
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const count = messages.length;
  const last = messages[count - 1];
  return { count, text: last ? wrapperrBestText(last) : '' };
}

// Stream parser + buffer reader live in providers/deepseek-parser.js. They are injected before
// this script by the service worker (see AI_SCRIPTS in background/service-worker.js) and expose
// the global readBestDeepSeekText() used below.

// getCurrentState: network-first with a mandatory grace period before DOM fallback.
// DeepSeek's DOM renders markdown as HTML; falling back too early returns plain text and the SW
// considers it stable, discarding the markdown forever. 3 s grace mirrors Gemini's / Grok's fix
// for the same failure mode.
function getCurrentState({ sentAt, baselineCount }) {
  const netText = readBestDeepSeekText(sentAt);
  if (netText) {
    window.__wrapperrDeepSeekDomGrace = null;
    return netText;
  }
  const now = Date.now();
  if (!window.__wrapperrDeepSeekDomGrace) window.__wrapperrDeepSeekDomGrace = now;
  if (now - window.__wrapperrDeepSeekDomGrace < 3000) return '';
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  if (messages.length <= (baselineCount || 0)) return '';
  return wrapperrBestText(messages[messages.length - 1]);
}

// readLatestResponse: see chatgpt.js. Network buffer preferred (DeepSeek's DOM strips markdown);
// DOM fallback uses the same RESPONSE_SELECTOR as getBaseline.
function readLatestResponse() {
  const netText = readBestDeepSeekText(0);
  if (netText) return netText;
  const messages = document.querySelectorAll(RESPONSE_SELECTOR);
  const last = messages[messages.length - 1];
  return last ? wrapperrBestText(last) : '';
}

// ─── applyOptions helpers ────────────────────────────────────────────────────────────────────

// sleep / withTimeout / waitFor / norm / isVisible — small utility set mirrored from gemini.js
// and grok.js so the apply pipeline behaves identically across AIs. Issues to know:
//  • sleep is the only way to ride out DeepSeek's pulse animation on toggle clicks (~150 ms).
//  • withTimeout protects each apply step so a stuck selector can't eat into injectMessage's budget.
//  • waitFor swallows predicate errors — a transient null deref during DeepSeek's React rerender
//    must not abort the whole apply step.
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function withTimeout(p, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`applyOptions step timed out after ${ms}ms`)), ms);
    Promise.resolve(p).then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function waitFor(predicate, maxMs = 1500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const v = predicate();
      if (v) return v;
    } catch { /* keep polling — React rerenders may transiently detach nodes */ }
    await sleep(50);
  }
  return null;
}

function norm(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// TOGGLE_PULSE_MS — DeepSeek animates a ~150 ms pulse on toggle click before flipping
// aria-pressed. Reading state immediately after click returns the OLD value, so every
// verification step waits at least this long. Increase if you ever see verify-flakiness.
const TOGGLE_PULSE_MS = 200;

// ─── DeepThink / Web Search toggle pills ─────────────────────────────────────────────────────
//
// Captured DOM from chat.deepseek.com (2026-06, fresh chat):
//   <div tabindex="0" aria-pressed="false" class="f79352dc ds-toggle-button ds-toggle-button--m">
//     ...icon... <span class="_6dbc175">DeepThink</span>
//   </div>
// State is authoritatively `aria-pressed="true|false"`. The hashed wrapper class (f79352dc)
// rotates per deploy; ds-toggle-button is the stable hook. Both toggles share the same wrapper
// class — they're only distinguished by their inner <span> text.

// findToggleButton: locate the DeepThink or Search toggle. Three ranked strategies (best→worst).
// DeepSeek ships UI updates frequently and rarely uses stable testids, so each rung uses a
// different anchor — the hashed class survives shortest, the role/attr survives longer, the
// generic clickable-near-composer survives even a full toggle-component refactor.
//   1. Best: `div.ds-toggle-button` whose inner text equals the label. ds-* classes are
//      DeepSeek's design-system prefix and rotate slower than the per-deploy hashed siblings.
//   2. Middle: any element carrying `aria-pressed` whose text equals the label. Survives a
//      design-system class rename as long as the toggle semantics stay accessible.
//   3. Worst: clickable `<div tabindex="0">` near the composer textarea whose text equals
//      the label. Survives both a class rename AND aria-attr removal — last resort.
// Guard: every rung uses exact-text equality on a label node when present, not substring,
// because "Search" is a substring of many unrelated UI strings ("Search history", etc.).
function findToggleButton(label) {
  const want = norm(label);

  for (const el of document.querySelectorAll('div.ds-toggle-button')) {
    if (!isVisible(el)) continue;
    const span = el.querySelector('span');
    const text = norm(span ? span.textContent : el.textContent);
    if (text === want) return el;
  }

  for (const el of document.querySelectorAll('[aria-pressed]')) {
    if (!isVisible(el)) continue;
    const span = el.querySelector('span');
    const text = norm(span ? span.textContent : el.textContent);
    if (text === want) return el;
  }

  const composer = document.querySelector('textarea[name="search"], textarea[placeholder*="DSeek"], textarea');
  const scope = composer ? (composer.closest('form, div[class*="chat"], body') || document) : document;
  for (const el of scope.querySelectorAll('div[tabindex="0"]')) {
    if (!isVisible(el)) continue;
    if (norm(el.textContent) === want) return el;
  }
  return null;
}

// isTogglePressed: read the toggle's ON state. aria-pressed is W3C-standard and language-
// independent. Returns null = "unknown" so callers can refuse to click an unknown-state row
// when turning OFF (clicking unknown could accidentally turn it ON instead). Matches the
// rowChecked() pattern in gemini.js.
function isTogglePressed(el) {
  const v = el?.getAttribute?.('aria-pressed');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

// setToggle: drive a DeepThink/Search pill to wantOn. Idempotent — reads state first, clicks
// only on mismatch, so a no-op never flips OFF something the user wanted ON. Pulse-animation
// grace period before verification (see TOGGLE_PULSE_MS). Throws on hard failure; the
// orchestrator catches, warns, and the send proceeds.
async function setToggle(label, wantOn) {
  const btn = findToggleButton(label);
  if (!btn) throw new Error(`toggle "${label}" not found`);

  const state = isTogglePressed(btn);
  if (state === wantOn) return;
  // Unknown state + wantOn=false → don't click; we could be ON or OFF and a click toggles it.
  // Better to skip than to accidentally turn it ON. Mirrors gemini.js rowChecked policy.
  if (state === null && !wantOn) return;

  btn.click();
  await sleep(TOGGLE_PULSE_MS);

  const ok = await waitFor(() => {
    const fresh = findToggleButton(label);
    return isTogglePressed(fresh) === wantOn;
  }, 1500);
  if (!ok) throw new Error(`toggle "${label}" did not reach ${wantOn ? 'on' : 'off'}`);
}

// DEEPSEEK_TOGGLE_LABELS: Wrapperr feature ids → DeepSeek's visible pill labels. Keep in sync
// with web/lib/aiFeatures.ts deepseek.feature.options. The label on screen is "Search" even
// though our id is "web-search" — id stays stable for persisted user selections.
const DEEPSEEK_TOGGLE_LABELS = { 'deepthink': 'DeepThink', 'web-search': 'Search' };

// applyFeature: reconcile the Tools slot with single-select semantics matching the web pill:
//   undefined     → both toggles OFF (pill cleared = no tool active)
//   'deepthink'   → DeepThink ON, Search OFF
//   'web-search'  → Search ON, DeepThink OFF
// IMPORTANT asymmetry: DeepSeek's NATIVE UI allows DeepThink + Search simultaneously, but
// Wrapperr's UI is single-select. We enforce mutual exclusivity from our side by turning the
// non-selected one OFF — even if the user had it ON manually on DeepSeek's site. Off-first
// matters when applyIntelligence below ALSO touches DeepThink (Expert mode often pairs with
// DeepThink): we don't want to fight ourselves.
async function applyFeature(featureId) {
  if (featureId !== undefined && !DEEPSEEK_TOGGLE_LABELS[featureId]) {
    console.warn(`[wrapperr] deepseek: unknown feature "${featureId}", ignoring`);
    return;
  }
  for (const [id, label] of Object.entries(DEEPSEEK_TOGGLE_LABELS)) {
    if (id !== featureId) {
      try { await setToggle(label, false); }
      catch (err) { console.warn(`[wrapperr] deepseek: could not turn off ${label}:`, err && err.message || err); }
    }
  }
  if (featureId) await setToggle(DEEPSEEK_TOGGLE_LABELS[featureId], true);
}

// ─── Mode radios (Instant / Expert / Vision) ────────────────────────────────────────────────
//
// Captured DOM from chat.deepseek.com (2026-06):
//   <div data-model-type="default|expert|vision" role="radio" aria-checked="true|false"
//        class="_9f2341b _18572c1 [_31a22b0]">
// `data-model-type` is the stable hook — three values: "default" (= Wrapperr's 'instant'),
// "expert", "vision". `aria-checked` is the authoritative selected state. The third class
// (_31a22b0 in the capture) appears only on the selected row but is hashed, so we rely on
// aria-checked instead. Vision may be tier-locked on some accounts; clicking a locked radio
// no-ops, our verify step catches it, the warn fires, and the send proceeds — matching the
// "never block the send" contract.

// MODE_TYPE_MAP: Wrapperr intelligence ids → DeepSeek's data-model-type attribute value.
// 'instant' deliberately maps to "default" — the radio that's pre-selected when DeepSeek
// loads, matching the page header "Start chatting with Instant". Keep in sync with
// web/lib/aiFeatures.ts deepseek.intelligence.options.
const MODE_TYPE_MAP = { 'instant': 'default', 'expert': 'expert', 'vision': 'vision' };

// MODE_LABELS: parallel label map used by the rung-2/rung-3 finders when data-model-type is
// gone. Kept separate from MODE_TYPE_MAP so a label rewording doesn't silently break the
// attribute path.
const MODE_LABELS = { 'instant': 'Instant', 'expert': 'Expert', 'vision': 'Vision' };

// findModeRadio: locate the mode radio for `modeId`. Three ranked strategies (best→worst):
//   1. Best: `div[data-model-type="<type>"][role="radio"]` — DeepSeek's own data attribute,
//      stable across deploys (the value is part of the API contract sent to their backend).
//   2. Middle: any `[role="radio"]` whose inner text equals the label — survives a
//      data-model-type rename as long as the row stays an a11y radio.
//   3. Worst: any element with `aria-checked` whose visible text equals the label — survives
//      both a data-attr rename AND a role change, as long as the toggle stays accessible.
function findModeRadio(modeId) {
  const type = MODE_TYPE_MAP[modeId];
  const label = MODE_LABELS[modeId];
  if (!type || !label) return null;

  const byAttr = document.querySelector(`div[data-model-type="${type}"][role="radio"]`);
  if (byAttr && isVisible(byAttr)) return byAttr;

  const want = norm(label);
  for (const el of document.querySelectorAll('[role="radio"]')) {
    if (!isVisible(el)) continue;
    if (norm(el.textContent) === want) return el;
  }

  for (const el of document.querySelectorAll('[aria-checked]')) {
    if (!isVisible(el)) continue;
    if (norm(el.textContent) === want) return el;
  }
  return null;
}

// isModeSelected: read the radio's aria-checked. Same null="unknown" policy as toggles.
function isModeSelected(el) {
  const v = el?.getAttribute?.('aria-checked');
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

// applyIntelligence: switch DeepSeek to the requested mode. undefined → leave the mode
// untouched (Mode pill unset means "whatever the site already has"). Flow: find the target
// radio → short-circuit if already selected → click → verify aria-checked flipped to true →
// done. Tier-locked Vision: the click no-ops, verify times out, orchestrator warns, send
// proceeds on whatever mode was previously active.
async function applyIntelligence(modeId) {
  if (modeId === undefined) return;
  if (!MODE_TYPE_MAP[modeId]) {
    console.warn(`[wrapperr] deepseek: unknown mode "${modeId}", ignoring`);
    return;
  }

  const row = findModeRadio(modeId);
  if (!row) throw new Error(`mode row "${modeId}" not found`);

  if (isModeSelected(row) === true) return;

  row.click();
  await sleep(TOGGLE_PULSE_MS);

  const ok = await waitFor(() => {
    const fresh = findModeRadio(modeId);
    return isModeSelected(fresh) === true;
  }, 1500);
  if (!ok) throw new Error(`mode did not switch to "${modeId}" after click (tier-locked?)`);
}

// ─── applyOptions orchestrator ───────────────────────────────────────────────────────────────

// applyOptions: best-effort apply DeepSeek's Tools + Mode to match the user's Wrapperr pill
// selections BEFORE injecting the prompt. Shape:
//   { feature?: 'deepthink'|'web-search', intelligence?: 'instant'|'expert'|'vision' }
// Hard contract: MUST NOT throw. Each slot is independently try/catch-wrapped with a time
// budget; on failure we console.warn and fall through to injectMessage — better to send the
// prompt without the toggle than to abort entirely. Order: features first, then mode. Reason:
// some modes (Expert) may auto-toggle DeepThink on DeepSeek's side; doing features first and
// mode second means the mode's side-effects win, which matches user intent (they picked the
// mode deliberately). When BOTH slots are undefined we return without touching the page —
// backwards-compat with the pre-options send flow.
async function applyOptions(options) {
  if (!options || typeof options !== 'object') return;
  const hasAny = options.feature !== undefined || options.intelligence !== undefined;
  if (!hasAny) return;

  const TOTAL_BUDGET_MS = 12000;
  const PER_ACTION_MS = 6000;
  const start = Date.now();
  const remaining = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - start));

  try {
    if (remaining() > 0) {
      await withTimeout(applyFeature(options.feature), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] DeepSeek applyFeature failed, sending without it:', err && err.message || err);
  }

  try {
    if (remaining() > 0) {
      await withTimeout(applyIntelligence(options.intelligence), Math.min(PER_ACTION_MS, remaining()));
    }
  } catch (err) {
    console.warn('[wrapperr] DeepSeek applyIntelligence failed, sending without it:', err && err.message || err);
  }
}

// Message listener — guarded against double-installation if the script is re-injected.
// Same shape as gemini.js / chatgpt.js / grok.js: WRAPPERR_INJECT_ONLY captures baseline + injects,
// WRAPPERR_GET_STATE returns the current best response text for the SW's stability poller.
// WRAPPERR_REREAD_LATEST returns the freshest last-assistant-message text without any inject.
if (!window.__wrapperrAIListenerOn) {
  window.__wrapperrAIListenerOn = true;
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'WRAPPERR_INJECT_ONLY') {
      (async () => {
        try {
          const baseline = getBaseline();
          // applyOptions is best-effort and catches its own failures internally — a broken
          // DeepSeek selector must never block the send (see the applyOptions block above).
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
