# AI Features — Per-AI Chat Bar Architecture

> User-requested doc. Created in Session 1 (ChatGPT + scaffolding) of a 5-session rollout.
> Don't delete in a doc-cleanup pass unless the user says so.

## Why this exists

The chat bar used to show the same three placeholder pills (`Web Search / Compare / Deep Research`) for every AI, none of which did anything. We replaced that with **per-AI controls** that match each AI's native UI and actually toggle the matching feature on the AI's website via the Wrapperr extension. **Compare AI** moved out of the placeholder pill and is now a standalone button.

5 sessions total, one per AI: **ChatGPT** (done), Claude, Grok, Gemini, DeepSeek. Perplexity is parked.

## What the user sees

- Selecting an AI swaps the chat-bar pills to that AI's set. Each AI declares zero or more pills: `Tools`, `Model`, `Style`, `Skills`. Each pill is a dropdown.
- Selections are remembered per-AI across switches (Thinking sticks to ChatGPT even after a Claude bounce). Persisted in `localStorage` under `wrapperr:aiOptions:v1`.
- A `Compare` button sits to the right of the Timeout pill, always visible. Clicking it enters Compare mode (existing behaviour — Compare ignores per-AI pills, it's a baseline shootout).
- For AIs whose pills are stubbed (not yet wired to the AI's site), a dim caption appears under the controls: *"tool toggles for {AI} wire up in a later session"*. Removed per-AI as each session ships.

## Files

### Config
- `web/lib/aiFeatures.ts` — the **only** source of truth for what pills exist per AI. Declares `AI_FEATURES` (per-AI pill config) and `FEATURES_WIRED` (which AIs' extension-side `applyOptions` is implemented). To add a new AI's pills: add an entry here, then implement that AI's `applyOptions` in its content script. UI changes are zero.
- `web/lib/aiOptionsStorage.ts` — tiny `loadAIOptions` / `saveAIOptions` over `localStorage`. SSR-safe, errors swallowed.

### State + UI
- `web/app/page.tsx` — owns `aiOptions: AIOptionsMap`. Persisted on every change. Passes `aiOptions[selectedAI]` into `sendMessageToAI` for the single-AI flow. `runCompareTurn` deliberately ignores it (commented).
- `web/components/chat/InputBar.tsx` — renders the pills from `AI_FEATURES[selectedAI]` in fixed `PILL_ORDER`. Pills hide entirely when Compare is on. Standalone Compare button sits between Timeout and the AI switcher.
- `web/components/layout/ChatWindow.tsx`, `web/components/chat/ActiveChatState.tsx` — pure prop drilling.

### Extension plumbing
- `web/lib/extension.ts::sendMessageToAI` — accepts an optional 4th `options` arg. Added to the postMessage payload only when present, so legacy callers are byte-identical.
- `extension/content-scripts/wrapperr-bridge.js` — forwards `event.data` whole to the SW; `options` rides along.
- `extension/background/service-worker.js` — destructures `options` from `WRAPPERR_SEND`, threads into `sendToAI`, includes in the `WRAPPERR_INJECT_ONLY` payload to the content script.
- Per-AI content script — its `WRAPPERR_INJECT_ONLY` listener calls `applyOptions(msg.options)` **before** `injectMessage`. `applyOptions` is best-effort: failures log and proceed.

## ChatGPT `applyOptions` specifics (`extension/content-scripts/chatgpt.js`)

Tools popover (Web Search / Deep Research) and the model picker are Radix DropdownMenu triggers. Synthetic `.click()` does not open them — Radix listens to `pointerdown`. We dispatch the full pointer-mouse-click sequence via `radixOpen()`.

Three ranked fallback strategies per action (the **3-fallbacks rule** — AI vendors change DOM weekly):

| Action | Strategy 1 (best) | Strategy 2 | Strategy 3 |
|---|---|---|---|
| Tools trigger | `[data-testid="composer-plus-btn"]` | `#composer-plus-btn` | `button[aria-haspopup="menu"][aria-label*="Add files" i]` |
| Tool row (Web Search / Deep Research) | `[role="menuitemradio"]` text-match | `[role="menuitem"]` text-match | `[data-radix-collection-item]` text-match |
| Model trigger | `button.__composer-pill[aria-haspopup="menu"]` with known model label | `form button[aria-haspopup="menu"]` with known model label | any button with known model label, nearest to textarea |
| Model row | `data-testid="model-switcher-*-thinking"` (or `*` without `-thinking` for Instant) | `[role="menuitemradio"]` text-match | `[role="menuitem"]` / `[data-radix-collection-item]` text-match |

Other invariants:
- **Time budget**: 5s per action, 10s total. Exceeded → log + send anyway.
- **State detection**: tool rows read `aria-checked` then `data-state`. Model trigger label-text is read directly for the fast-path "already in target state" check.
- **Popover close** after every toggle — Escape first, trigger-click fallback — so a stray send-button click can't land on an open menu.
- **Deep Research absent** → log clearly, close popover, proceed without it. Gated by ChatGPT account tier / quota.

## Compare AI

Unchanged from before this work. `runCompareTurn` does NOT pass `aiOptions[ai]` to its parallel `sendMessageToAI` calls — deliberate: Compare is a baseline shootout, per-AI tools/models apply only to the single-AI flow. Comment in `page.tsx` documents this.

## How to add a new AI (Sessions 2-5 template)

1. **Add config** in `web/lib/aiFeatures.ts`:
   - Add the AI's entry to `AI_FEATURES` with its `feature` / `intelligence` / `style` / `skills` pills and options.
   - Flip `FEATURES_WIRED[ai]` to `true`.
2. **Implement `applyOptions(options)`** in `extension/content-scripts/<ai>.js`:
   - Mirror chatgpt.js: three ranked strategies per action, captured-DOM comment header, per-action try/catch, time budget, popover-close wait.
   - If the AI uses Radix (Claude does), reuse `radixOpen` pattern.
   - Each option id in `options.feature` / `options.intelligence` / `options.style` matches the id you declared in `aiFeatures.ts`.
3. **Selector capture** — open the AI's site, capture trigger + rows + ON/OFF states for every option you implement. Three states per Radix-toggle row are usually enough.
4. **Test** — confirm each toggle actually flips on the AI's site; confirm sending with no options selected is byte-identical to today; confirm Compare still works.
5. **Push** — per CLAUDE.md, only after explicit user approval.

## Known limitations / open questions

- Skills pill (Claude) is intentionally `comingSoon: true` — render-only, no logic.
- `multiSelect?: boolean` exists on `AIFeaturePill` as a forward-compat hook. No current pill uses it; the renderer in InputBar already branches correctly when it lands.
- Gemini model labels (`3.1 Flash-Light`, `3.5 Flash`, `3.1 Pro`, `Troubleshooting`) and DeepSeek intelligence labels (`Instant`, `Expert`, `Vision`) are from the user's spec — verify against the live UI before Sessions 4-5.
- Content-script re-injection logs a benign `SyntaxError: Identifier 'RESPONSE_SELECTOR' has already been declared` in the chatgpt.com console. The error is caught by the SW's `injectContentScript` try/catch and has no functional effect — the first injection's handlers stay live. Wrapping the whole file in a `window.__wrapperrChatGPTLoaded` load guard would silence it cleanly.
