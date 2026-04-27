'use client';

import { useEffect, useRef } from 'react';
import type { Message, AIModel } from '@/lib/types';
import MessageBubble from './MessageBubble';
import InputBar from './InputBar';

interface Props {
  messages: Message[];
  selectedAI: AIModel;
  loading: boolean;
  transferring: boolean;
  onSendMessage: (text: string) => void;
  onSwitchAI: (ai: AIModel) => void;
}

export default function ActiveChatState({
  messages,
  selectedAI,
  loading,
  transferring,
  onSendMessage,
  onSwitchAI,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  return (
    <div className="flex flex-col h-full">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto px-4 py-6">
        <div className="max-w-3xl mx-auto">
          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center h-full min-h-[300px] text-center">
              <p className="text-2xl font-semibold text-white mb-2">What&apos;s on your mind?</p>
              <p className="text-muted text-sm">Select an AI below and start typing.</p>
            </div>
          )}

          {messages.map((msg) => (
            <MessageBubble key={msg.id} message={msg} />
          ))}

          {transferring && (
            <div className="flex justify-start mb-4">
              <div className="bg-surface border border-amber-500/30 text-amber-300 rounded-2xl rounded-tl-sm px-4 py-3 text-sm flex items-center gap-2">
                <span className="w-3 h-3 border border-amber-400/40 border-t-amber-400 rounded-full animate-spin shrink-0" />
                Transferring context to new AI…
              </div>
            </div>
          )}

          {loading && !transferring && (
            <div className="flex justify-start mb-4">
              <div className="bg-surface border border-border rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex gap-1">
                  <span className="w-1.5 h-1.5 bg-muted rounded-full animate-bounce [animation-delay:0ms]" />
                  <span className="w-1.5 h-1.5 bg-muted rounded-full animate-bounce [animation-delay:150ms]" />
                  <span className="w-1.5 h-1.5 bg-muted rounded-full animate-bounce [animation-delay:300ms]" />
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input bar */}
      <InputBar
        selectedAI={selectedAI}
        onSendMessage={onSendMessage}
        onSwitchAI={onSwitchAI}
        loading={loading || transferring}
      />
    </div>
  );
}
