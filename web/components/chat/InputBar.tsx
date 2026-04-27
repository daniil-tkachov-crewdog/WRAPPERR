'use client';

import { useState, useRef, useEffect } from 'react';
import type { AIModel } from '@/lib/types';
import { AI_MODELS } from '@/lib/constants';

interface Props {
  selectedAI: AIModel;
  onSendMessage: (text: string) => void;
  onSwitchAI: (ai: AIModel) => void;
  disabled?: boolean;
  loading?: boolean;
}

export default function InputBar({
  selectedAI,
  onSendMessage,
  onSwitchAI,
  disabled = false,
  loading = false,
}: Props) {
  const [text, setText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const currentAI = AI_MODELS.find((m) => m.id === selectedAI)!;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
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
    onSendMessage(trimmed);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }

  function handleAISelect(ai: AIModel) {
    onSwitchAI(ai);
    setDropdownOpen(false);
  }

  return (
    <div className="border-t border-border bg-bg px-4 py-4">
      <div className="max-w-3xl mx-auto">
        <div className="flex items-end gap-3 bg-surface border border-border rounded-2xl px-4 py-3">
          {/* AI selector */}
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
              <div className="absolute bottom-full mb-2 left-0 bg-surface border border-border rounded-xl py-1 shadow-xl z-50 min-w-[140px]">
                {AI_MODELS.map((model) => (
                  <button
                    key={model.id}
                    onClick={() => handleAISelect(model.id)}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors ${
                      model.id === selectedAI
                        ? 'text-white bg-white/5'
                        : 'text-muted hover:text-white hover:bg-white/5'
                    }`}
                  >
                    {model.label}
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
