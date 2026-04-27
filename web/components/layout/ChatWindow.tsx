'use client';

import Link from 'next/link';
import type { User } from '@supabase/supabase-js';
import type { Message, AIModel } from '@/lib/types';
import NotLoggedInState from '@/components/chat/NotLoggedInState';
import NoExtensionState from '@/components/chat/NoExtensionState';
import ActiveChatState from '@/components/chat/ActiveChatState';
import InputBar from '@/components/chat/InputBar';

interface Props {
  user: User | null;
  extensionActive: boolean;
  messages: Message[];
  selectedAI: AIModel;
  loading: boolean;
  transferring: boolean;
  onSendMessage: (text: string) => void;
  onSwitchAI: (ai: AIModel) => void;
}

export default function ChatWindow({
  user,
  extensionActive,
  messages,
  selectedAI,
  loading,
  transferring,
  onSendMessage,
  onSwitchAI,
}: Props) {
  if (!user) {
    return (
      <div className="flex flex-col flex-1 h-full relative">
        <div className="absolute top-4 right-4 z-10">
          <Link
            href="/login"
            className="bg-white text-black text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity"
          >
            Login
          </Link>
        </div>

        <div className="flex-1 flex flex-col">
          <div className="flex-1 flex items-center justify-center px-6">
            <NotLoggedInState />
          </div>
          <div className="border-t border-border px-4 py-4">
            <div className="max-w-3xl mx-auto">
              <div className="flex items-center gap-3 bg-surface border border-border rounded-2xl px-4 py-3 opacity-40 cursor-not-allowed">
                <span className="text-xs text-muted">ChatGPT</span>
                <div className="w-px h-5 bg-border" />
                <span className="flex-1 text-sm text-muted">Login to start chatting…</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

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

  return (
    <div className="flex flex-col flex-1 h-full">
      <ActiveChatState
        messages={messages}
        selectedAI={selectedAI}
        loading={loading}
        transferring={transferring}
        onSendMessage={onSendMessage}
        onSwitchAI={onSwitchAI}
      />
    </div>
  );
}
