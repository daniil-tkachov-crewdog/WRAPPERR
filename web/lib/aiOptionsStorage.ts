import type { AIModel } from './types';

// AIOptionsMap — per-AI selected options, keyed by AIModel. Each slot is independent: the user
// can have ChatGPT in Thinking and Claude in Sonnet at the same time, and switching the active
// AI doesn't wipe either. `feature` is typed as string | string[] so a future multi-select pill
// (see AIFeaturePill.multiSelect in aiFeatures.ts) can opt into the array shape without a
// schema change. Today every pill is single-select so it's always a string.
export type AIOptionSlots = {
  feature?: string | string[];
  intelligence?: string;
  style?: string;
};
export type AIOptionsMap = Partial<Record<AIModel, AIOptionSlots>>;

const STORAGE_KEY = 'wrapperr:aiOptions:v1';

// loadAIOptions — read the saved map from localStorage. Wrapped in try/catch + SSR guard
// because: (a) this file is imported by client components but Next.js may evaluate it during
// server render where window is undefined, (b) localStorage can throw in private-mode Safari /
// disabled-storage scenarios. On any failure, return an empty map and let the user start fresh.
export function loadAIOptions(): AIOptionsMap {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed as AIOptionsMap;
    return {};
  } catch {
    return {};
  }
}

// saveAIOptions — persist the map. Same SSR + try/catch guard. Errors here are non-fatal:
// worst case the user's pill selections don't survive a refresh. Intentionally not persisted
// to Supabase — feature toggles are session-local UX, not chat data.
export function saveAIOptions(map: AIOptionsMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore — see comment above
  }
}
