import type { AIModel } from './types';

// AIFeatureOption — a single selectable item inside a pill's dropdown. `comingSoon` renders the
// row disabled with a small "SOON" badge. Same visual treatment as the existing Perplexity
// "soon" row in the AI dropdown — keep the look consistent.
export type AIFeatureOption = {
  id: string;
  label: string;
  comingSoon?: boolean;
};

// AIFeaturePill — one dropdown pill on the chat bar (e.g. ChatGPT's "Tools"). `comingSoon: true`
// on the whole pill means the pill renders disabled with a "SOON" badge (e.g. Claude's Skills).
// `multiSelect: true` means options toggle independently (state value becomes string[] for that
// slot). Default (undefined/false) = single-select radio behavior, which matches every AI's
// native UI today. multiSelect is a forward-compat hook — no current pill uses it. If you flip
// it on for a slot, the renderer in InputBar.tsx + the applyOptions in the relevant content
// script both need to handle the array shape.
export type AIFeaturePill = {
  label: string;
  options: AIFeatureOption[];
  comingSoon?: boolean;
  multiSelect?: boolean;
};

// AIFeatureConfig — declarative per-AI chat-bar layout. The UI renders one pill per defined
// key, in fixed order: feature → intelligence → style → skills. Slots not declared are skipped.
// Each AI's content script reads only the keys it knows how to apply on the real site (see e.g.
// extension/content-scripts/chatgpt.js::applyOptions). Adding a new AI = new entry here + a
// matching applyOptions in the AI's content script. The web UI does NOT need any other change.
export interface AIFeatureConfig {
  feature?: AIFeaturePill;
  intelligence?: AIFeaturePill;
  style?: AIFeaturePill;
  skills?: AIFeaturePill;
}

// AI_FEATURES — single source of truth for what pills each AI shows. ChatGPT is fully specced
// (Session 1). Others are stubbed with the user's specified option lists so the UI renders
// completely now, but their content-script applyOptions is a no-op until each one's own session
// lands. Perplexity is omitted entirely (parked).
export const AI_FEATURES: Partial<Record<AIModel, AIFeatureConfig>> = {
  chatgpt: {
    feature: {
      label: 'Tools',
      options: [
        { id: 'create-image',  label: 'Create Image',  comingSoon: true },
        { id: 'deep-research', label: 'Deep Research' },
        { id: 'web-search',    label: 'Web Search' },
      ],
    },
    intelligence: {
      label: 'Model',
      options: [
        { id: 'instant',  label: 'Instant' },
        { id: 'thinking', label: 'Thinking' },
      ],
    },
  },
  claude: {
    feature: {
      label: 'Tools',
      options: [
        { id: 'research',   label: 'Research' },
        { id: 'web-search', label: 'Web Search' },
      ],
    },
    style: {
      label: 'Style',
      options: [
        { id: 'normal',            label: 'Normal' },
        { id: 'learning',          label: 'Learning' },
        { id: 'concise',           label: 'Concise' },
        { id: 'explanatory',       label: 'Explanatory' },
        { id: 'formal',            label: 'Formal' },
        { id: 'pragmatic-analyst', label: 'Pragmatic Analyst' },
      ],
    },
    skills: {
      label: 'Skills',
      comingSoon: true,
      options: [],
    },
    intelligence: {
      label: 'Model',
      options: [
        { id: 'opus-4-8',   label: 'Opus 4.8' },
        { id: 'sonnet-4-6', label: 'Sonnet 4.6' },
        { id: 'haiku-4-5',  label: 'Haiku 4.5' },
      ],
    },
  },
  grok: {
    intelligence: {
      label: 'Mode',
      options: [
        { id: 'fast',   label: 'Fast' },
        { id: 'auto',   label: 'Auto' },
        { id: 'expert', label: 'Expert' },
        { id: 'heavy',  label: 'Heavy' },
      ],
    },
  },
  gemini: {
    feature: {
      label: 'Tools',
      options: [
        { id: 'add-from-drive',  label: 'Add from Drive', comingSoon: true },
        { id: 'create-image',    label: 'Create Image',   comingSoon: true },
        { id: 'canvas',          label: 'Canvas',         comingSoon: true },
        { id: 'deep-research',   label: 'Deep Research' },
        { id: 'create-music',    label: 'Create Music',   comingSoon: true },
        { id: 'guided-learning', label: 'Guided Learning' },
      ],
    },
    intelligence: {
      label: 'Model',
      // Labels must match gemini.google.com's mode-picker rows EXACTLY — the content script
      // matches rows by visible text. Verified against production 2026-06: "3.1 Flash-Lite" /
      // "3.5 Flash" / "3.1 Pro". "Troubleshooting" was removed from Gemini's picker, so it was
      // dropped here too. The 'flash-light' id is kept (despite the label spelling fix to
      // "Flash-Lite") because ids persist in users' localStorage (wrapperr:aiOptions:v1) —
      // renaming it would orphan saved selections. If you add a model here, also add it to
      // MODEL_LABELS in extension/content-scripts/gemini.js.
      options: [
        { id: 'flash-light',    label: '3.1 Flash-Lite' },
        { id: 'flash',          label: '3.5 Flash' },
        { id: 'pro',            label: '3.1 Pro' },
      ],
    },
  },
  deepseek: {
    feature: {
      label: 'Tools',
      options: [
        { id: 'deepthink',  label: 'DeepThink' },
        { id: 'web-search', label: 'Web Search' },
      ],
    },
    intelligence: {
      label: 'Mode',
      options: [
        { id: 'instant', label: 'Instant' },
        { id: 'expert',  label: 'Expert' },
        { id: 'vision',  label: 'Vision' },
      ],
    },
  },
};

// FEATURES_WIRED — which AIs have their content-script applyOptions implemented. The web UI
// uses this to decide whether to show a "tool toggles for X wire up in a later session" dim
// caption under the pills. Flip an AI to true in the session that wires its applyOptions.
// Perplexity is parked (not in AI_FEATURES at all), so it's not in this map either.
export const FEATURES_WIRED: Record<AIModel, boolean> = {
  chatgpt:    true,
  claude:     true,
  grok:       true,
  perplexity: false,
  gemini:     true,
  deepseek:   false,
};

// Pill render order. Same for every AI to keep the chat bar visually consistent across switches
// — users learn "leftmost = tools, rightmost = skills". If a future AI's native UI strongly
// expects a different order, revisit (likely by adding `order?: (keyof AIFeatureConfig)[]` to
// AIFeatureConfig rather than per-AI special casing).
export const PILL_ORDER: (keyof AIFeatureConfig)[] = ['feature', 'intelligence', 'style', 'skills'];
