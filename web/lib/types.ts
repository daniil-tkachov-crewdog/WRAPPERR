export type AIModel = 'chatgpt' | 'claude' | 'grok' | 'perplexity' | 'gemini' | 'deepseek';
export type AppearanceMode = 'dark' | 'light' | 'system';

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  aiModel?: AIModel;
  timestamp: number;
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
