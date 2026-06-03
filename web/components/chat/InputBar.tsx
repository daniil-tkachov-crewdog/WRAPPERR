'use client';

import { useState, useRef, useEffect } from 'react';
import type { AIModel } from '@/lib/types';
import { AI_MODELS } from '@/lib/constants';

interface Props {
  selectedAI: AIModel;
  timeoutMs: number;
  onSendMessage: (text: string) => void;
  onSwitchAI: (ai: AIModel) => void;
  onTimeoutChange: (ms: number) => void;
  disabled?: boolean;
  loading?: boolean;
  // quote: optional text the user highlighted from a prior assistant message via "Ask about it".
  // When set, we render a chip above the textarea and prepend the text as a Markdown blockquote
  // to the sent message so the AI sees the quoted context unambiguously. Cleared via onClearQuote
  // (X button on the chip) or automatically after send.
  quote?: string | null;
  onClearQuote?: () => void;
}

const TIMEOUT_OPTIONS: { ms: number; label: string }[] = [
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
  { ms: 120_000, label: '2m' },
  { ms: 300_000, label: '5m' },
];

export default function InputBar({
  selectedAI,
  timeoutMs,
  onSendMessage,
  onSwitchAI,
  onTimeoutChange,
  disabled = false,
  loading = false,
  quote = null,
  onClearQuote,
}: Props) {
  const [text, setText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  // attachedFile: filename the user picked via the "+" button. Placeholder only — the file
  // bytes are never read or uploaded. Just rendered as a chip and cleared on send.
  const [attachedFile, setAttachedFile] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAI = AI_MODELS.find((m) => m.id === selectedAI)!;
  const currentTimeoutLabel =
    TIMEOUT_OPTIONS.find((o) => o.ms === timeoutMs)?.label ?? `${Math.round(timeoutMs / 1000)}s`;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (timeoutRef.current && !timeoutRef.current.contains(e.target as Node)) {
        setTimeoutOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [text]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleSend() {
    const trimmed = text.trim();
    if (!trimmed || disabled || loading) return;
    // Compose the final outgoing message. If a quote is attached, prepend it as a Markdown
    // blockquote — each line of the quote gets a leading "> ". Every AI we drive (ChatGPT,
    // Claude, Grok, Perplexity, Gemini, DeepSeek) understands this convention as "user is
    // asking about this quoted bit", so we don't need per-AI handling here.
    const composed = quote
      ? `${quote.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${trimmed}`
      : trimmed;
    onSendMessage(composed);
    setText('');
    onClearQuote?.();
    // Attached file is placeholder — drop the chip after send so the next message starts clean.
    setAttachedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  // handleFileChange: fires when the user picks a file via the hidden <input type="file">.
  // Stashes the filename only — never reads, uploads, or sends the file. Placeholder until
  // real attachment support lands.
  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (f) setAttachedFile(f.name);
  }

  function handleAISelect(ai: AIModel) {
    onSwitchAI(ai);
    setDropdownOpen(false);
  }

  return (
    <div className="border-t border-border bg-bg px-4 py-4">
      <div className="max-w-3xl mx-auto">
        {quote && (
          <div className="mb-2 flex items-start gap-2 bg-surface border border-border rounded-xl px-3 py-2">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted shrink-0 mt-0.5"
            >
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
            <p className="flex-1 text-xs text-muted line-clamp-2 leading-relaxed">{quote}</p>
            <button
              onClick={onClearQuote}
              title="Clear reference"
              className="text-muted hover:text-white transition-colors shrink-0"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        {/* Attached-file chip: placeholder. Shows filename only — nothing is uploaded yet. */}
        {attachedFile && (
          <div className="mb-2 flex items-center gap-2 bg-surface border border-border rounded-xl px-3 py-2">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted shrink-0">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/>
            </svg>
            <p className="flex-1 text-xs text-white truncate">{attachedFile}</p>
            <span className="text-[10px] uppercase tracking-wide text-muted/60 shrink-0">Placeholder</span>
            <button
              onClick={() => {
                setAttachedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              title="Remove file"
              className="text-muted hover:text-white transition-colors shrink-0"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex items-end gap-3 bg-surface border border-border rounded-2xl px-4 py-3">
          {/* Hidden file input. The "+" button triggers it via .click(). Placeholder — no upload. */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* "+" button: opens the native file picker. Pure placeholder; file is never sent. */}
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={loading}
            title="Attach file (placeholder)"
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full text-muted hover:text-white hover:bg-white/5 transition-colors disabled:opacity-40"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="5" x2="12" y2="19"/>
              <line x1="5" y1="12" x2="19" y2="12"/>
            </svg>
          </button>

          {/* Timeout selector */}
          <div className="relative shrink-0" ref={timeoutRef}>
            <button
              onClick={() => setTimeoutOpen((v) => !v)}
              disabled={loading}
              title="Response timeout"
              className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-white transition-colors disabled:opacity-50 py-1"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10"/>
                <polyline points="12 6 12 12 16 14"/>
              </svg>
              <span className="text-white">{currentTimeoutLabel}</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                className={`transition-transform ${timeoutOpen ? 'rotate-180' : ''}`}
              >
                <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
              </svg>
            </button>

            {timeoutOpen && (
              <div className="absolute bottom-full mb-2 left-0 bg-surface border border-border rounded-xl py-1 shadow-xl z-50 min-w-[100px]">
                {TIMEOUT_OPTIONS.map((opt) => (
                  <button
                    key={opt.ms}
                    onClick={() => {
                      onTimeoutChange(opt.ms);
                      setTimeoutOpen(false);
                    }}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                      opt.ms === timeoutMs
                        ? 'text-white bg-white/5'
                        : 'text-muted hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="w-px h-5 bg-border shrink-0" />

          {/* Textarea */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? '' : 'Message…'}
            disabled={disabled || loading}
            rows={1}
            className="flex-1 bg-transparent text-white text-sm placeholder-muted outline-none leading-relaxed min-h-[24px] max-h-[200px] disabled:opacity-40"
          />

          {/* AI selector — moved to the right of the textarea (Perplexity-style placement).
              Dropdown anchors to right-0 so it opens up-and-leftward instead of overflowing. */}
          <div className="relative shrink-0" ref={dropdownRef}>
            <button
              onClick={() => setDropdownOpen((v) => !v)}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs font-medium text-muted hover:text-white transition-colors disabled:opacity-50 py-1"
            >
              <span className="text-white">{currentAI.label}</span>
              <svg
                width="10"
                height="10"
                viewBox="0 0 10 10"
                fill="currentColor"
                className={`transition-transform ${dropdownOpen ? 'rotate-180' : ''}`}
              >
                <path d="M1 3l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
              </svg>
            </button>

            {dropdownOpen && (
              <div className="absolute bottom-full mb-2 right-0 bg-surface border border-border rounded-xl py-1 shadow-xl z-50 min-w-[140px]">
                {AI_MODELS.map((model) => (
                  // comingSoon providers (e.g. Perplexity) are shown disabled with a label and
                  // can't be selected — clicking does nothing.
                  <button
                    key={model.id}
                    onClick={() => { if (!model.comingSoon) handleAISelect(model.id); }}
                    disabled={model.comingSoon}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors flex items-center justify-between gap-2 ${
                      model.comingSoon
                        ? 'text-muted/50 cursor-not-allowed'
                        : model.id === selectedAI
                        ? 'text-white bg-white/5'
                        : 'text-muted hover:text-white hover:bg-white/5'
                    }`}
                  >
                    <span>{model.label}</span>
                    {model.comingSoon && (
                      <span className="text-[10px] uppercase tracking-wide text-muted/50">Coming soon</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Send button */}
          <button
            onClick={handleSend}
            disabled={!text.trim() || disabled || loading}
            className="shrink-0 w-8 h-8 flex items-center justify-center rounded-lg bg-white text-black disabled:opacity-30 hover:opacity-80 transition-opacity"
          >
            {loading ? (
              <span className="w-3 h-3 border border-black/30 border-t-black rounded-full animate-spin" />
            ) : (
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 12V2M2 7l5-5 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            )}
          </button>
        </div>

        <p className="text-center text-muted text-xs mt-2">
          Shift+Enter for new line · Enter to send
        </p>
      </div>
    </div>
  );
}
