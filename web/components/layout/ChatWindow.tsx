'use client';

import type { User } from '@supabase/supabase-js';
import type { Message, AIModel } from '@/lib/types';
import NoExtensionState from '@/components/chat/NoExtensionState';
import ActiveChatState from '@/components/chat/ActiveChatState';

// ChatWindow: top-level container for the right pane. Renders one of two states based on
// whether the Wrapperr Chrome extension is active. Auth gating is intentionally OFF — the app
// works without a Supabase session (chats just aren't persisted; saveChat() in page.tsx no-ops
// when user is null). Re-enable the auth block by reintroducing the `if (!user)` branch when
// Supabase email rate limits / login flow is sorted.
interface Props {
  user: User | null;
  extensionActive: boolean;
  messages: Message[];
  selectedAI: AIModel;
  loading: boolean;
  transferring: boolean;
  timeoutMs: number;
  onSendMessage: (text: string) => void;
  onSwitchAI: (ai: AIModel) => void;
  onTimeoutChange: (ms: number) => void;
}

export default function ChatWindow({
  // user is accepted for parity with page.tsx but no longer used to gate the UI.
  user: _user,
  extensionActive,
  messages,
  selectedAI,
  loading,
  transferring,
  timeoutMs,
  onSendMessage,
  onSwitchAI,
  onTimeoutChange,
}: Props) {
  // Extension-not-installed state: the chat UI is fully blocked because every message has to be
  // delivered through the extension's content scripts. Without it there is nothing to send to.
  if (!extensionActive) {
    return (
      <div className="flex flex-col flex-1 h-full">
        <div className="flex-1 flex items-center justify-center px-6">
          <NoExtensionState />
        </div>
        <div className="border-t border-border px-4 py-4">
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center gap-3 bg-surface border border-border rounded-2xl px-4 py-3 opacity-40 cursor-not-allowed">
              <span className="text-xs text-muted">ChatGPT</span>
              <div className="w-px h-5 bg-border" />
              <span className="flex-1 text-sm text-muted">Install extension to start chatting…</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Active chat state: extension is connected, so we render the live message list, AI selector
  // dropdown, and input bar. Receives the parent's send/switch/timeout callbacks.
  return (
    <div className="flex flex-col flex-1 h-full">
      <ActiveChatState
        messages={messages}
        selectedAI={selectedAI}
        loading={loading}
        transferring={transferring}
        timeoutMs={timeoutMs}
        onSendMessage={onSendMessage}
        onSwitchAI={onSwitchAI}
        onTimeoutChange={onTimeoutChange}
      />
    </div>
  );
}
