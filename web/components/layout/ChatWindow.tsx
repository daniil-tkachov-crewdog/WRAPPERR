'use client';

import type { User } from '@supabase/supabase-js';
import type { Message, AIModel } from '@/lib/types';
import type { AIOptionsMap } from '@/lib/aiOptionsStorage';
import type { WrapperrError } from '@/lib/errors';
import NoExtensionState from '@/components/chat/NoExtensionState';
import ActiveChatState from '@/components/chat/ActiveChatState';

// ChatWindow: top-level container for the right pane. Renders one of two states based on
// whether the Wrapperr Chrome extension is active. Auth gating is intentionally OFF — the app
// works without a Supabase session (chats just aren't persisted; saveChat() in page.tsx no-ops
// when user is null). Re-enable the auth block by reintroducing the `if (!user)` branch when
// Supabase email rate limits / login flow is sorted.
// chatName is threaded down to ActiveChatState → TopBar so the header shows the current chat's
// name (or "New chat" placeholder until the first message names the chat).
interface Props {
  user: User | null;
  extensionActive: boolean;
  messages: Message[];
  selectedAI: AIModel;
  loading: boolean;
  transferring: boolean;
  timeoutMs: number;
  chatName?: string;
  onSendMessage: (text: string) => void;
  onSwitchAI: (ai: AIModel) => void;
  onTimeoutChange: (ms: number) => void;
  // Compare AI — see web/app/page.tsx for the state lifecycle. compareMode toggles the feature;
  // compareAIs is the editable set (frozen once compareLocked flips on first send).
  compareMode: boolean;
  compareAIs: AIModel[];
  compareLocked: boolean;
  onToggleCompare: () => void;
  onToggleCompareAI: (ai: AIModel) => void;
  onRetryCompareSlide: (compareId: string, ai: AIModel) => void;
  // Per-AI pill selections (Tools / Model / Style). aiOptions is the whole map (so we can pass
  // any AI's slot down to InputBar without re-keying), onAIOptionChange writes one slot at a
  // time. See web/lib/aiFeatures.ts + web/lib/aiOptionsStorage.ts.
  aiOptions: AIOptionsMap;
  onAIOptionChange: (ai: AIModel, slot: 'feature' | 'intelligence' | 'style', value: string | string[] | undefined) => void;
  // onSaveToMemory: persist a piece of text (full message or highlighted snippet) to the user's
  // personal memory. Drilled down to every MessageBubble. Returns the save outcome so the bubble
  // can show transient feedback. See page.tsx addMemory + lib/memory.ts.
  onSaveToMemory: (text: string) => Promise<'saved' | 'limit' | 'error'>;
  // pageError: non-message-bound failures (saveChat upsert, transient extension issues) so the
  // chat thread itself stays clean. Dismissable. AI-flow failures are anchored to the prompt
  // bubble that caused them (see message.wrapperrError), not here.
  pageError?: WrapperrError | null;
  onDismissPageError?: () => void;
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
  chatName,
  onSendMessage,
  onSwitchAI,
  onTimeoutChange,
  compareMode,
  compareAIs,
  compareLocked,
  onToggleCompare,
  onToggleCompareAI,
  onRetryCompareSlide,
  aiOptions,
  onAIOptionChange,
  onSaveToMemory,
  pageError,
  onDismissPageError,
}: Props) {
  // Extension-not-installed state: the chat UI is fully blocked because every message has to be
  // delivered through the extension's content scripts. The composer placeholder below mirrors
  // the Spectrum surface so it still looks like the same app, just disabled.
  if (!extensionActive) {
    return (
      <div className="flex flex-col flex-1 h-full">
        <div className="flex-1 flex items-center justify-center px-6">
          <NoExtensionState />
        </div>
        <div style={{ padding: '10px 28px 22px' }}>
          <div style={{ maxWidth: 720, margin: '0 auto' }}>
            <div
              className="flex items-center"
              style={{
                gap: 12,
                background: 'var(--panel)',
                border: '1px solid var(--line)',
                borderRadius: 18,
                padding: '14px 16px',
                opacity: 0.4,
                cursor: 'not-allowed',
              }}
            >
              <span style={{ fontSize: 12.5, color: 'var(--dim)' }}>ChatGPT</span>
              <div style={{ width: 1, height: 20, background: 'var(--line)' }} />
              <span style={{ flex: 1, fontSize: 14, color: 'var(--dim)' }}>
                Install extension to start chatting…
              </span>
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
        chatName={chatName}
        onSendMessage={onSendMessage}
        onSwitchAI={onSwitchAI}
        onTimeoutChange={onTimeoutChange}
        compareMode={compareMode}
        compareAIs={compareAIs}
        compareLocked={compareLocked}
        onToggleCompare={onToggleCompare}
        onToggleCompareAI={onToggleCompareAI}
        onRetryCompareSlide={onRetryCompareSlide}
        aiOptions={aiOptions}
        onAIOptionChange={onAIOptionChange}
        onSaveToMemory={onSaveToMemory}
        pageError={pageError}
        onDismissPageError={onDismissPageError}
      />
    </div>
  );
}
