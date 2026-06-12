// Provider/appearance enums — single source of truth for AI ids used across the web app and
// extension. Adding a new AI = add the id here, then add matching entries in AI_MODELS,
// AI_FEATURES, FEATURES_WIRED, the extension manifest, and a new content script.
export type AIModel = 'chatgpt' | 'claude' | 'grok' | 'perplexity' | 'gemini' | 'deepseek';
export type AppearanceMode = 'dark' | 'light' | 'system';

// CompareResponse: one slot inside a compare-turn message — holds the per-AI streamed answer.
// status drives the slide rendering: 'pending' shows a spinner, 'done' renders content as
// Markdown, 'error' shows the error banner with a retry button. Compare turns are NOT persisted
// to Supabase right now (intentional, per plan), so this type only lives in client state.
export interface CompareResponse {
  ai: AIModel;
  content: string;
  status: 'pending' | 'done' | 'error';
  error?: string;
}

// Message: extended with a third role 'compare'. When role === 'compare', `responses` is the
// authoritative payload and `content` is unused (kept empty). When role is 'user' or 'assistant'
// the shape is exactly as before — no existing call site needs to change.
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'compare';
  content: string;
  aiModel?: AIModel;
  timestamp: number;
  responses?: CompareResponse[];
}

// Chat — the full Supabase row shape used when loading a chat into the active view. `messages`
// is stored as JSONB so schema migrations on individual messages are cheap, but pushing huge
// histories will eventually hit Supabase row-size limits — chunking is a future concern.
export interface Chat {
  id: string;
  user_id: string;
  name: string;
  messages: Message[];
  ai_model: AIModel;
  created_at: string;
  updated_at: string;
}

// ChatSummary — lightweight projection used by the sidebar list. Intentionally omits `messages`
// to keep the list query cheap (one round-trip can return all 25 caps without bandwidth blowup).
export interface ChatSummary {
  id: string;
  name: string;
  ai_model: AIModel;
  updated_at: string;
}

// Profile — mirrors the `profiles` table. Created automatically by the handle_new_user trigger
// in schema.sql, so the web app can assume a row exists for every authenticated user.
export interface Profile {
  id: string;
  name: string;
  default_ai: AIModel;
  appearance: AppearanceMode;
}
