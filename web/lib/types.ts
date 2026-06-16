import type { WrapperrError } from './errors';

export type AIModel = 'chatgpt' | 'claude' | 'grok' | 'perplexity' | 'gemini' | 'deepseek';
export type AppearanceMode = 'dark' | 'light' | 'system';

// CompareResponse: one slot inside a compare-turn message — holds the per-AI streamed answer.
// status drives the slide rendering: 'pending' shows a spinner, 'done' renders content as
// Markdown, 'error' shows the error banner with a retry button. Compare turns are NOT persisted
// to Supabase right now (intentional, per plan), so this type only lives in client state.
//
// error is now a structured WrapperrError so the slide can show stage + hint + Copy-details
// instead of a stringified one-liner. Legacy chats that still hold a string here are tolerated
// by the renderer.
export interface CompareResponse {
  ai: AIModel;
  content: string;
  status: 'pending' | 'done' | 'error';
  error?: WrapperrError | string;
}

// Message: extended with a third role 'compare'. When role === 'compare', `responses` is the
// authoritative payload and `content` is unused (kept empty). When role is 'user' or 'assistant'
// the shape is exactly as before, plus an optional wrapperrError marker — when present, the
// assistant bubble renders as an ErrorBubble instead of a plain markdown body. This keeps
// failures anchored to the prompt that caused them in the chat thread.
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'compare';
  content: string;
  aiModel?: AIModel;
  timestamp: number;
  responses?: CompareResponse[];
  wrapperrError?: WrapperrError;
}

export interface Chat {
  id: string;
  user_id: string;
  name: string;
  messages: Message[];
  ai_model: AIModel;
  created_at: string;
  updated_at: string;
}

export interface ChatSummary {
  id: string;
  name: string;
  ai_model: AIModel;
  updated_at: string;
}

export interface Profile {
  id: string;
  name: string;
  default_ai: AIModel;
  appearance: AppearanceMode;
}

// MemoryUnit: one saved piece of personal memory (a full message or a highlighted snippet).
// Stored in the shared `memories` Supabase table, partitioned per user via RLS (user_id +
// auth.uid() policies). `id` is a server UUID — never shown in the UI; the Memory tab renders a
// 1..n index instead. `memory_unit` is the raw text. One saved item = one MemoryUnit, regardless
// of length (as long as it fits MEMORY_CHAR_LIMIT). created_at is used only for stable ordering.
export interface MemoryUnit {
  id: string;
  memory_unit: string;
  created_at: string;
}
