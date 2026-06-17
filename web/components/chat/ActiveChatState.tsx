'use client';

import { useEffect, useRef, useState } from 'react';
import type { Message, AIModel } from '@/lib/types';
import type { AIOptionsMap } from '@/lib/aiOptionsStorage';
import { hueOf, tint } from '@/lib/constants';
import MessageBubble from './MessageBubble';
import InputBar from './InputBar';
import RelayCard from './RelayCard';
import CompareCard from './CompareCard';
import CompareSelectorCard from './CompareSelectorCard';
import ErrorDisplay from './ErrorDisplay';
import TopBar from '@/components/layout/TopBar';
import type { WrapperrError } from '@/lib/errors';

interface Props {
  messages: Message[];
  selectedAI: AIModel;
  loading: boolean;
  transferring: boolean;
  timeoutMs: number;
  chatName?: string;
  onSendMessage: (text: string) => void;
  onSwitchAI: (ai: AIModel) => void;
  onTimeoutChange: (ms: number) => void;
  // Compare AI props — see page.tsx for lifecycle. The selector card renders only while
  // compareMode === true && !compareLocked (pre-first-send). After the first compare send the
  // card is hidden and the locked set is reused for follow-ups.
  compareMode: boolean;
  compareAIs: AIModel[];
  compareLocked: boolean;
  onToggleCompare: () => void;
  onToggleCompareAI: (ai: AIModel) => void;
  onRetryCompareSlide: (compareId: string, ai: AIModel) => void;
  // onRetryMessage: re-check a normal single-AI assistant message — re-reads the AI's tab and
  // swaps the message content in place. Mirrors onRetryCompareSlide but for non-Compare bubbles.
  // Drilled down to each MessageBubble's re-check button. See retryMessage in page.tsx.
  onRetryMessage: (messageId: string, ai: AIModel) => Promise<void>;
  // Per-AI pill state. See ChatWindow.tsx for the same drilled props.
  aiOptions: AIOptionsMap;
  onAIOptionChange: (ai: AIModel, slot: 'feature' | 'intelligence' | 'style', value: string | string[] | undefined) => void;
  // onSaveToMemory: drilled to every MessageBubble for the "Save to Memory" button + right-click
  // popup. See ChatWindow.tsx / page.tsx.
  onSaveToMemory: (text: string) => Promise<'saved' | 'limit' | 'error'>;
  // Top-of-chat error banner. Used for non-message-bound failures (saveChat upsert, etc.); AI
  // round-trip failures land on the assistant bubble itself via message.wrapperrError.
  pageError?: WrapperrError | null;
  onDismissPageError?: () => void;
}

// ActiveChatState — the live chat view.
// Layout: [TopBar] [scrolling message list] [InputBar].
// Two derivations sit inside the message map:
//   1. Relay card insertion: when the current assistant message's aiModel differs from the
//      previous assistant message's aiModel, slot a <RelayCard from={prev} to={current}/>
//      immediately before the new message. This is the "signature handoff, made visible" — it
//      shows up retroactively in historical chats too without needing any new stored field.
//   2. transferring indicator hue: tint the spinner to the selectedAI hue instead of fixed
//      amber, so it reads as "Wrapperr is bringing in <next provider>".
// quote state lives here (not InputBar) so any MessageBubble can set it via onAskAbout.
export default function ActiveChatState({
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
  onRetryMessage,
  aiOptions,
  onAIOptionChange,
  onSaveToMemory,
  pageError,
  onDismissPageError,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [quote, setQuote] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  const activeHue = hueOf(selectedAI);

  return (
    <div className="flex flex-col h-full">
      <TopBar chatName={chatName} />

      {/* Messages area — centred 720px column. */}
      <div className="flex-1 overflow-y-auto" style={{ padding: '0 28px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto', padding: '30px 0 18px' }}>
          {/* pageError banner: dismissable, top-of-thread. Wired for failures that aren't tied
              to a single prompt (saveChat upsert, etc.). AI round-trip errors land on the
              assistant bubble itself (see MessageBubble + message.wrapperrError) so they stay
              anchored to the prompt that caused them. */}
          {pageError && (
            <div style={{ marginBottom: 18 }}>
              <ErrorDisplay
                error={pageError}
                variant="banner"
                onRetry={onDismissPageError}
                retryLabel="Dismiss"
              />
            </div>
          )}

          {messages.length === 0 && !loading && (
            <div className="flex flex-col items-center justify-center text-center" style={{ minHeight: 300 }}>
              <p style={{ fontSize: 22, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                What&apos;s on your mind?
              </p>
              <p style={{ color: 'var(--dim)', fontSize: 13 }}>
                Select an AI below and start typing.
              </p>
            </div>
          )}

          {messages.map((msg, idx) => {
            // Compare branch — fully separate render path. No relay derivation, no bubble.
            // The CompareCard owns its own slide state and selection UI.
            if (msg.role === 'compare') {
              return (
                <div key={msg.id}>
                  <CompareCard message={msg} onRetry={onRetryCompareSlide} />
                </div>
              );
            }

            // Relay derivation — find the previous assistant message and compare its aiModel.
            // We walk backwards rather than tracking outside the map so the rule is local.
            // Compare-role messages are skipped here so a Compare turn never triggers a relay
            // card on the next single-AI reply.
            let relay: { from: AIModel; to: AIModel } | null = null;
            if (msg.role === 'assistant' && msg.aiModel) {
              for (let j = idx - 1; j >= 0; j--) {
                const prev = messages[j];
                if (prev.role === 'assistant' && prev.aiModel) {
                  if (prev.aiModel !== msg.aiModel) {
                    relay = { from: prev.aiModel, to: msg.aiModel };
                  }
                  break;
                }
              }
            }

            return (
              <div key={msg.id}>
                {relay && <RelayCard from={relay.from} to={relay.to} />}
                <MessageBubble message={msg} onAskAbout={setQuote} onSaveToMemory={onSaveToMemory} onRetryMessage={onRetryMessage} />
              </div>
            );
          })}

          {/* Compare selector — appears in-thread while Compare is on and not yet locked.
              Sits where the next assistant message will appear, so picking AIs reads as
              setting up the "panel" that will answer. Hidden after first Compare send. */}
          {compareMode && !compareLocked && (
            <CompareSelectorCard selected={compareAIs} onToggle={onToggleCompareAI} />
          )}

          {/* Transferring indicator. Re-tinted to the to-provider (selectedAI) hue. */}
          {transferring && (
            <div
              className="flex items-center mb-4"
              style={{
                gap: 10,
                padding: '12px 16px',
                borderRadius: 14,
                border: `1px solid ${tint(activeHue, 0.3)}`,
                background: tint(activeHue, 0.08),
                color: activeHue,
                fontSize: 13,
              }}
            >
              <span
                className="animate-spin"
                style={{
                  width: 12,
                  height: 12,
                  border: `1.5px solid ${tint(activeHue, 0.4)}`,
                  borderTopColor: activeHue,
                  borderRadius: '50%',
                  flexShrink: 0,
                }}
              />
              <span className="font-mono" style={{ fontSize: 12, color: 'var(--mid)' }}>
                relaying context to new model…
              </span>
            </div>
          )}

          {/* Loading dots — neutral, since the active provider's reply hasn't materialised yet. */}
          {loading && !transferring && (
            <div className="flex" style={{ marginBottom: 16, paddingLeft: 18 }}>
              <div className="flex gap-1">
                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--dim)', animationDelay: '0ms' }} />
                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--dim)', animationDelay: '150ms' }} />
                <span className="w-1.5 h-1.5 rounded-full animate-bounce" style={{ background: 'var(--dim)', animationDelay: '300ms' }} />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      </div>

      {/* Input bar — receives chatName not needed here. */}
      <div style={{ padding: '0 28px' }}>
        <InputBar
          selectedAI={selectedAI}
          timeoutMs={timeoutMs}
          onSendMessage={onSendMessage}
          onSwitchAI={onSwitchAI}
          onTimeoutChange={onTimeoutChange}
          loading={loading || transferring}
          quote={quote}
          onClearQuote={() => setQuote(null)}
          compareMode={compareMode}
          compareCount={compareAIs.length}
          compareLocked={compareLocked}
          onToggleCompare={onToggleCompare}
          // Disable send while Compare is on but fewer than 2 AIs are picked. Once locked, the
          // set can't drop below 2 so this naturally stops gating.
          disabled={compareMode && !compareLocked && compareAIs.length < 2}
          aiOptions={aiOptions}
          onAIOptionChange={onAIOptionChange}
        />
      </div>
    </div>
  );
}
