'use client';

import { useState, useRef, useEffect } from 'react';
import type { AIModel } from '@/lib/types';
import { AI_MODELS, hueOf, tint } from '@/lib/constants';
import ProviderMark from './ProviderMark';

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
  // Compare AI — when compareMode is true: the Compare feature pill becomes active, the model
  // selector dropdown is replaced with a "Compare" badge (since switching the single AI doesn't
  // apply), and the helper line reflects fan-out. compareCount is the size of the chosen set.
  // onToggleCompare flips the parent's compareMode (the only way to switch off besides new chat
  // / refresh, per spec).
  compareMode?: boolean;
  compareCount?: number;
  compareLocked?: boolean;
  onToggleCompare?: () => void;
}

const TIMEOUT_OPTIONS: { ms: number; label: string }[] = [
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
  { ms: 120_000, label: '2m' },
  { ms: 300_000, label: '5m' },
];

// FEATURE_OPTIONS: placeholder feature pills (Web Search / Compare / Deep Research). Purely
// visual right now — selecting one does nothing in the send pipeline. Wired into local state so
// the chosen pill highlights with the active provider hue. When the real features land, lift
// this state up and thread it into the send call.
type FeatureId = 'web-search' | 'compare' | 'deep-research';
const FEATURE_OPTIONS: { id: FeatureId; label: string }[] = [
  { id: 'web-search', label: 'Web Search' },
  { id: 'compare', label: 'Compare' },
  { id: 'deep-research', label: 'Deep Research' },
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
  compareMode = false,
  compareCount = 0,
  compareLocked = false,
  onToggleCompare,
}: Props) {
  const [text, setText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  const [featureOpen, setFeatureOpen] = useState(false);
  // selectedFeature: which placeholder pill is active. Null = none. Only one at a time
  // (ChatGPT-style). Has zero effect on send right now.
  const [selectedFeature, setSelectedFeature] = useState<FeatureId | null>(null);
  // attachedFile: filename the user picked via the "+" button. Placeholder only — the file
  // bytes are never read or uploaded. Just rendered as a chip and cleared on send.
  const [attachedFile, setAttachedFile] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<HTMLDivElement>(null);
  const featureRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAI = AI_MODELS.find((m) => m.id === selectedAI)!;
  const currentTimeoutLabel =
    TIMEOUT_OPTIONS.find((o) => o.ms === timeoutMs)?.label ?? `${Math.round(timeoutMs / 1000)}s`;
  // currentFeature: which pill shows as the "active" label on the trigger button. Compare
  // takes precedence over the placeholder selectedFeature when compareMode is true — that way
  // the trigger reflects the real feature state, not the cosmetic one.
  const currentFeature = compareMode
    ? FEATURE_OPTIONS.find((f) => f.id === 'compare') ?? null
    : FEATURE_OPTIONS.find((f) => f.id === selectedFeature) ?? null;
  // Active hue drives the composer border/focus ring, model chip, send button, helper line.
  const hue = hueOf(selectedAI);

  // Close dropdowns on outside click. One listener handles all three so the bottom row stays
  // tidy — each dropdown only closes if the click landed outside its own container.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (timeoutRef.current && !timeoutRef.current.contains(e.target as Node)) {
        setTimeoutOpen(false);
      }
      if (featureRef.current && !featureRef.current.contains(e.target as Node)) {
        setFeatureOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-grow textarea — clamps at 200px so the composer doesn't eat the viewport on long drafts.
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
    // blockquote — each line of the quote gets a leading "> ". Every AI we drive understands
    // this convention as "user is asking about this quoted bit", so no per-AI handling.
    const composed = quote
      ? `${quote.split('\n').map((l) => `> ${l}`).join('\n')}\n\n${trimmed}`
      : trimmed;
    onSendMessage(composed);
    setText('');
    onClearQuote?.();
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

  // handleFeatureSelect: pick a placeholder feature pill, or deselect it if the same option is
  // clicked again. Only one feature can be active at a time. The Compare entry is special: it
  // bubbles up to onToggleCompare in the parent (real feature, not a placeholder); the other
  // two are still cosmetic.
  function handleFeatureSelect(id: FeatureId) {
    if (id === 'compare') {
      onToggleCompare?.();
      setFeatureOpen(false);
      return;
    }
    setSelectedFeature((cur) => (cur === id ? null : id));
    setFeatureOpen(false);
  }

  function handleAISelect(ai: AIModel) {
    onSwitchAI(ai);
    setDropdownOpen(false);
  }

  return (
    <div style={{ padding: '10px 0 22px', background: 'linear-gradient(180deg, transparent, var(--bg) 38%)' }}>
      <div style={{ maxWidth: 720, margin: '0 auto' }}>
        {/* Quote chip — rendered above the composer when the user highlighted text via
            "Ask about it". The text is prepended as a Markdown blockquote at send time. */}
        {quote && (
          <div
            className="mb-2 flex items-start"
            style={{
              gap: 8,
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: '8px 12px',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--dim)', flexShrink: 0, marginTop: 2 }}>
              <polyline points="9 17 4 12 9 7" />
              <path d="M20 18v-2a4 4 0 0 0-4-4H4" />
            </svg>
            <p style={{ flex: 1, fontSize: 12, color: 'var(--mid)', lineHeight: 1.55, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
              {quote}
            </p>
            <button
              onClick={onClearQuote}
              title="Clear reference"
              style={{ color: 'var(--dim)', flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer' }}
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
          <div
            className="mb-2 flex items-center"
            style={{
              gap: 8,
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              padding: '8px 12px',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--dim)', flexShrink: 0 }}>
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
            <p style={{ flex: 1, fontSize: 12, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {attachedFile}
            </p>
            <span className="font-mono" style={{ fontSize: 10, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.06em', flexShrink: 0 }}>
              Placeholder
            </span>
            <button
              onClick={() => {
                setAttachedFile(null);
                if (fileInputRef.current) fileInputRef.current.value = '';
              }}
              title="Remove file"
              style={{ color: 'var(--dim)', flexShrink: 0, background: 'transparent', border: 'none', cursor: 'pointer' }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        {/* Composer surface — radius 18, tinted border + focus ring in the active provider hue.
            Two-row layout: textarea up top, controls split left/right on the bottom row. */}
        <div
          style={{
            background: 'var(--panel)',
            borderRadius: 18,
            padding: '14px 14px 10px',
            border: `1px solid ${tint(hue, 0.4)}`,
            boxShadow: `0 0 0 3px ${tint(hue, 0.08)}, 0 10px 30px rgba(0,0,0,0.4)`,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {/* Hidden file input. The "+" button triggers it via .click(). Placeholder — no upload. */}
          <input
            ref={fileInputRef}
            type="file"
            className="hidden"
            onChange={handleFileChange}
          />

          {/* Textarea row. */}
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={disabled ? '' : 'Message…'}
            disabled={disabled || loading}
            rows={1}
            className="w-full bg-transparent outline-none resize-none disabled:opacity-40"
            style={{
              color: 'var(--text)',
              fontSize: 14.5,
              lineHeight: 1.5,
              minHeight: 24,
              maxHeight: 200,
              padding: '2px 4px',
            }}
          />

          {/* Controls row. */}
          <div className="flex items-center" style={{ gap: 4 }}>
            {/* "+" button: opens the native file picker. Pure placeholder; file is never sent. */}
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={loading}
              title="Attach file (placeholder)"
              className="shrink-0 transition-colors disabled:opacity-40"
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                display: 'grid',
                placeItems: 'center',
                color: 'var(--mid)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>

            {/* Feature pill: Web Search / Compare / Deep Research. Active selection tints
                with the provider hue. Placeholder — no effect on send. */}
            <div className="relative shrink-0" ref={featureRef}>
              <button
                onClick={() => setFeatureOpen((v) => !v)}
                disabled={loading}
                title={currentFeature ? `${currentFeature.label} (placeholder)` : 'Features (placeholder)'}
                className="flex items-center transition-colors disabled:opacity-50"
                style={{
                  gap: 7,
                  padding: '7px 11px',
                  borderRadius: 9,
                  color: currentFeature ? hue : 'var(--mid)',
                  background: currentFeature ? tint(hue, 0.08) : 'transparent',
                  border: 'none',
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
                </svg>
                <span>{currentFeature ? currentFeature.label : 'Web Search'}</span>
              </button>

              {featureOpen && (
                <div
                  className="absolute bottom-full mb-2 left-0 shadow-xl z-50"
                  style={{
                    background: 'var(--panel)',
                    border: '1px solid var(--line)',
                    borderRadius: 12,
                    padding: 4,
                    minWidth: 180,
                  }}
                >
                  {FEATURE_OPTIONS.map((opt) => {
                    // Compare's active state is the parent compareMode, not local selectedFeature.
                    // That way clicking it twice (on → off) reflects the real feature state.
                    const active = opt.id === 'compare' ? compareMode : opt.id === selectedFeature;
                    return (
                      <button
                        key={opt.id}
                        onClick={() => handleFeatureSelect(opt.id)}
                        className="w-full text-left transition-colors flex items-center justify-between"
                        style={{
                          padding: '8px 12px',
                          gap: 8,
                          fontSize: 13,
                          color: active ? hue : 'var(--mid)',
                          background: active ? tint(hue, 0.08) : 'transparent',
                          border: 'none',
                          borderRadius: 8,
                          cursor: 'pointer',
                        }}
                      >
                        <span>{opt.label}</span>
                        {active && (
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Timeout pill — mono numeric label per design. */}
            <div className="relative shrink-0" ref={timeoutRef}>
              <button
                onClick={() => setTimeoutOpen((v) => !v)}
                disabled={loading}
                title="Response timeout"
                className="flex items-center transition-colors disabled:opacity-50"
                style={{
                  gap: 7,
                  padding: '7px 11px',
                  borderRadius: 9,
                  color: 'var(--mid)',
                  background: 'transparent',
                  border: 'none',
                  fontSize: 12.5,
                  cursor: 'pointer',
                }}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 7v5l3 2" />
                </svg>
                <span className="font-mono">{currentTimeoutLabel}</span>
              </button>

              {timeoutOpen && (
                <div
                  className="absolute bottom-full mb-2 left-0 shadow-xl z-50"
                  style={{
                    background: 'var(--panel)',
                    border: '1px solid var(--line)',
                    borderRadius: 12,
                    padding: 4,
                    minWidth: 110,
                  }}
                >
                  {TIMEOUT_OPTIONS.map((opt) => {
                    const active = opt.ms === timeoutMs;
                    return (
                      <button
                        key={opt.ms}
                        onClick={() => {
                          onTimeoutChange(opt.ms);
                          setTimeoutOpen(false);
                        }}
                        className="w-full text-left transition-colors font-mono"
                        style={{
                          padding: '8px 12px',
                          fontSize: 13,
                          color: active ? 'var(--text)' : 'var(--mid)',
                          background: active ? 'var(--raise)' : 'transparent',
                          border: 'none',
                          borderRadius: 8,
                          cursor: 'pointer',
                          display: 'block',
                        }}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div style={{ flex: 1 }} />

            {/* Model selector chip — provider mark + label + chevron, tinted with the active
                hue. Replaced by a static "Compare" badge while compareMode is on, since
                switching the single AI is meaningless (and forbidden by spec) in that mode. */}
            {compareMode ? (
              <div
                className="flex items-center shrink-0"
                title={
                  compareLocked
                    ? `Compare AI · locked to ${compareCount} models`
                    : 'Compare AI · pick at least 2 above'
                }
                style={{
                  gap: 7,
                  padding: '6px 10px',
                  borderRadius: 10,
                  border: '1px solid var(--line)',
                  background: 'var(--raise)',
                  color: 'var(--text)',
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="7" height="7" rx="1.5" />
                  <rect x="14" y="3" width="7" height="7" rx="1.5" />
                  <rect x="3" y="14" width="7" height="7" rx="1.5" />
                  <rect x="14" y="14" width="7" height="7" rx="1.5" />
                </svg>
                <span style={{ fontSize: 12.5, fontWeight: 540 }}>Compare</span>
                <span className="font-mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>
                  {compareCount}/6
                </span>
              </div>
            ) : (
            <div className="relative shrink-0" ref={dropdownRef}>
              <button
                onClick={() => setDropdownOpen((v) => !v)}
                disabled={loading}
                className="flex items-center transition-colors disabled:opacity-50"
                style={{
                  gap: 8,
                  padding: '6px 9px 6px 8px',
                  borderRadius: 10,
                  border: `1px solid ${tint(hue, 0.35)}`,
                  background: tint(hue, 0.08),
                  cursor: 'pointer',
                }}
              >
                <span style={{ color: hue, display: 'grid', placeItems: 'center' }}>
                  <ProviderMark id={selectedAI} size={15} />
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 540 }}>
                  {currentAI.label}
                </span>
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  style={{
                    color: 'var(--mid)',
                    transition: 'transform 120ms',
                    transform: dropdownOpen ? 'rotate(180deg)' : 'none',
                  }}
                >
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>

              {dropdownOpen && (
                <div
                  className="absolute bottom-full mb-2 right-0 shadow-xl z-50"
                  style={{
                    background: 'var(--panel)',
                    border: '1px solid var(--line)',
                    borderRadius: 12,
                    padding: 4,
                    minWidth: 170,
                  }}
                >
                  {AI_MODELS.map((model) => {
                    const active = model.id === selectedAI;
                    return (
                      <button
                        key={model.id}
                        onClick={() => {
                          if (!model.comingSoon) handleAISelect(model.id);
                        }}
                        disabled={model.comingSoon}
                        className="w-full flex items-center justify-between transition-colors"
                        style={{
                          padding: '8px 12px',
                          gap: 10,
                          fontSize: 13,
                          color: model.comingSoon
                            ? 'var(--faint)'
                            : active
                            ? 'var(--text)'
                            : 'var(--mid)',
                          background: active ? tint(model.hue, 0.08) : 'transparent',
                          border: 'none',
                          borderRadius: 8,
                          cursor: model.comingSoon ? 'not-allowed' : 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        <span className="flex items-center" style={{ gap: 9 }}>
                          <span style={{ color: model.hue, display: 'grid', placeItems: 'center' }}>
                            <ProviderMark id={model.id} size={13} />
                          </span>
                          <span>{model.label}</span>
                        </span>
                        {model.comingSoon && (
                          <span className="font-mono" style={{ fontSize: 10, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                            soon
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            )}

            {/* Send button — 36×36, provider hue background, dark glyph, hue-coloured glow. */}
            <button
              onClick={handleSend}
              disabled={!text.trim() || disabled || loading}
              style={{
                width: 36,
                height: 36,
                borderRadius: 11,
                border: 'none',
                cursor: !text.trim() || disabled || loading ? 'not-allowed' : 'pointer',
                marginLeft: 2,
                background: hue,
                color: '#1a1205',
                display: 'grid',
                placeItems: 'center',
                boxShadow: `0 4px 16px ${tint(hue, 0.4)}`,
                opacity: !text.trim() || disabled || loading ? 0.5 : 1,
                transition: 'opacity 120ms',
              }}
            >
              {loading ? (
                <span
                  className="animate-spin"
                  style={{
                    width: 14,
                    height: 14,
                    border: '1.5px solid rgba(26,18,5,0.3)',
                    borderTopColor: '#1a1205',
                    borderRadius: '50%',
                  }}
                />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
              )}
            </button>
          </div>
        </div>

        {/* Helper line — mono, with the active provider label tinted in its hue. In compareMode
            the wording changes to reflect fan-out and the locked/unlocked state. */}
        <div
          className="font-mono text-center"
          style={{ fontSize: 11, color: 'var(--faint)', marginTop: 11 }}
        >
          {compareMode ? (
            compareLocked ? (
              <>fanning out to <span style={{ color: 'var(--text)' }}>{compareCount}</span> AIs · click Compare again to switch off</>
            ) : compareCount >= 2 ? (
              <>ready · message will fan out to <span style={{ color: 'var(--text)' }}>{compareCount}</span> AIs in parallel</>
            ) : (
              <>pick at least 2 AIs above to enable sending</>
            )
          ) : (
            <>
              replying with{' '}
              <span style={{ color: hue }}>{currentAI.label}</span>{' '}
              · switch model anytime — the thread relays automatically
            </>
          )}
        </div>
      </div>
    </div>
  );
}
