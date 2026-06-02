import type { AIModel } from './types';

// AI_MODELS drives the picker in InputBar. `comingSoon: true` marks a provider that is not
// usable yet — the UI shows it greyed out with a "Coming soon" label and blocks selection.
// Perplexity is parked here: its Lexical composer injection is unreliable and it's abandoned
// for now (see extension/content-scripts/perplexity.js history).
export const AI_MODELS: { id: AIModel; label: string; url: string; comingSoon?: boolean }[] = [
  { id: 'chatgpt',    label: 'ChatGPT',    url: 'https://chatgpt.com' },
  { id: 'claude',     label: 'Claude',     url: 'https://claude.ai' },
  { id: 'grok',       label: 'Grok',       url: 'https://grok.com' },
  { id: 'perplexity', label: 'Perplexity', url: 'https://perplexity.ai', comingSoon: true },
  { id: 'gemini',     label: 'Gemini',     url: 'https://gemini.google.com' },
  { id: 'deepseek',   label: 'DeepSeek',   url: 'https://chat.deepseek.com' },
];

export const MAX_CHATS = 25;

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
