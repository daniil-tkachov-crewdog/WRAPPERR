import type { AIModel } from './types';

// AI_MODELS drives the picker in InputBar. `comingSoon: true` marks a provider that is not
// usable yet — the UI shows it greyed out with a "Coming soon" label and blocks selection.
// Perplexity is parked here: its Lexical composer injection is unreliable and it's abandoned
// for now (see extension/content-scripts/perplexity.js history).
// `hue` is the Spectrum signature colour (oklch) used to tint that provider's message spine,
// chip, model selector, composer focus ring and send button. Abstract brand-adjacent, not
// official brand colours. The matching CSS var (--p-<id>) lives in globals.css for places we
// need string interpolation against the var (e.g. focus shadow inline styles).
export const AI_MODELS: { id: AIModel; label: string; url: string; hue: string; comingSoon?: boolean }[] = [
  { id: 'chatgpt',    label: 'ChatGPT',    url: 'https://chatgpt.com',          hue: 'oklch(0.74 0.12 165)' },
  { id: 'claude',     label: 'Claude',     url: 'https://claude.ai',            hue: 'oklch(0.76 0.13 55)'  },
  { id: 'grok',       label: 'Grok',       url: 'https://grok.com',             hue: 'oklch(0.86 0.02 260)' },
  { id: 'perplexity', label: 'Perplexity', url: 'https://perplexity.ai',        hue: 'oklch(0.74 0.09 200)', comingSoon: true },
  { id: 'gemini',     label: 'Gemini',     url: 'https://gemini.google.com',    hue: 'oklch(0.70 0.13 255)' },
  { id: 'deepseek',   label: 'DeepSeek',   url: 'https://chat.deepseek.com',    hue: 'oklch(0.68 0.15 288)' },
];

// hueOf: look up the Spectrum hue for a provider id. Falls back to the ChatGPT hue if the id
// is unknown (defensive — should not happen, but cheap to handle).
export function hueOf(id: AIModel): string {
  return AI_MODELS.find((m) => m.id === id)?.hue ?? 'oklch(0.74 0.12 165)';
}

// tint: translucent variant of an oklch hue. The reference design uses this everywhere for
// surfaces (alpha ~0.08–0.16), borders (~0.30–0.40) and spines/connectors (~0.50–0.60).
// Implementation: replace the closing ")" of the oklch() string with "/ <a>)" so the alpha
// becomes the colour's own alpha channel — works in any modern browser.
export function tint(hue: string, alpha: number): string {
  return hue.replace(/\)\s*$/, ` / ${alpha})`);
}

export const MAX_CHATS = 25;

// MEMORY_CHAR_LIMIT: the per-user budget for personal memory, measured in characters (not
// tokens — simpler, no tokenizer dependency; ~2000 chars ≈ ~500 tokens). Memory is injected as
// context into the first prompt of every new chat / AI switch, so it eats into the model's
// context window — keep this conservative. Enforced in the web app (lib/memory.ts insertMemory),
// NOT at the DB layer. If you raise this, remember every saved char is re-sent on each injection.
export const MEMORY_CHAR_LIMIT = 2000;

export const SUMMARY_PROMPT = `Summarise this conversation for transfer to another AI so it can continue without loss of context.

Include:
- User goal
- Key context (facts, constraints, tools, names)
- What has been done and current state
- User preferences (tone, format, rules)
- Next step

Rules:
- Do not answer the task
- No filler or explanations
- Keep it concise and accurate

Output format:

CONTEXT SUMMARY
User goal:
Key context:
Progress:
Preferences:
Next step:`;
