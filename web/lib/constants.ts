import type { AIModel } from './types';

export const AI_MODELS: { id: AIModel; label: string; url: string }[] = [
  { id: 'chatgpt',    label: 'ChatGPT',    url: 'https://chatgpt.com' },
  { id: 'claude',     label: 'Claude',     url: 'https://claude.ai' },
  { id: 'grok',       label: 'Grok',       url: 'https://grok.com' },
  { id: 'perplexity', label: 'Perplexity', url: 'https://perplexity.ai' },
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
