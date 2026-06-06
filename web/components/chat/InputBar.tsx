'use client';

import { useState, useRef, useEffect } from 'react';
import type { AIModel } from '@/lib/types';
import type { AIOptionsMap } from '@/lib/aiOptionsStorage';
import { AI_MODELS, hueOf, tint } from '@/lib/constants';
import { AI_FEATURES, FEATURES_WIRED, PILL_ORDER, type AIFeatureConfig, type AIFeaturePill } from '@/lib/aiFeatures';
import ProviderMark from './ProviderMark';

// Per-AI slot keys we support today. Kept inline (not imported) because TypeScript's keyof on
// AIFeatureConfig already includes 'skills', and skills is render-only (no selection persists).
type SelectableSlot = 'feature' | 'intelligence' | 'style';

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
  // Compare AI — when compareMode is true: the standalone Compare button reads as ON, all per-AI
  // pills are hidden (Compare is a baseline shootout and per-AI tools don't apply), and the AI
  // selector dropdown is replaced with a "Compare" badge. compareCount is the size of the chosen
  // set. onToggleCompare flips the parent's compareMode.
  compareMode?: boolean;
  compareCount?: number;
  compareLocked?: boolean;
  onToggleCompare?: () => void;
  // Per-AI pill selections + writer. See web/lib/aiFeatures.ts (config) and
  // web/lib/aiOptionsStorage.ts (persistence).
  aiOptions: AIOptionsMap;
  onAIOptionChange: (ai: AIModel, slot: SelectableSlot, value: string | string[] | undefined) => void;
}

const TIMEOUT_OPTIONS: { ms: number; label: string }[] = [
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '1m' },
  { ms: 120_000, label: '2m' },
  { ms: 300_000, label: '5m' },
];

// PILL_ICONS — one tiny inline SVG per slot. We render different glyphs by slot (not by AI) so
// the chat bar reads the same across providers. Tools = globe, Model = spark, Style = brush,
// Skills = grid. Keep these small; the pill chrome owns most of the visual weight.
function PillIcon({ slot }: { slot: keyof AIFeatureConfig }) {
  const common = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (slot === 'feature') {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c2.5 2.7 2.5 15.3 0 18M12 3c-2.5 2.7-2.5 15.3 0 18" />
      </svg>
    );
  }
  if (slot === 'intelligence') {
    return (
      <svg {...common}>
        <path d="M12 2v4M12 18v4M4 12h4M16 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
      </svg>
    );
  }
  if (slot === 'style') {
    return (
      <svg {...common}>
        <path d="M4 20s2-1 4-1 3 2 6 2 6-4 6-4" />
        <path d="M14 4l6 6-4 4-6-6 4-4z" />
      </svg>
    );
  }
  // skills
  return (
    <svg {...common}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

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
  aiOptions,
  onAIOptionChange,
}: Props) {
  const [text, setText] = useState('');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [timeoutOpen, setTimeoutOpen] = useState(false);
  // openPillKey: which per-AI pill dropdown is currently open. Only one at a time. Keyed by
  // slot name ('feature' | 'intelligence' | 'style' | 'skills') because each AI has at most one
  // of each. Null means all closed.
  const [openPillKey, setOpenPillKey] = useState<keyof AIFeatureConfig | null>(null);
  // attachedFile: filename the user picked via the "+" button. Placeholder only — the file
  // bytes are never read or uploaded. Just rendered as a chip and cleared on send.
  const [attachedFile, setAttachedFile] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<HTMLDivElement>(null);
  // pillsContainerRef wraps ALL per-AI pills as one outside-click region. We don't need a ref
  // per pill because only one can be open at a time and clicking from one pill to another is
  // still inside this container — the click-outside handler closes the open one and the new
  // button's onClick opens the new one.
  const pillsContainerRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentAI = AI_MODELS.find((m) => m.id === selectedAI)!;
  const currentTimeoutLabel =
    TIMEOUT_OPTIONS.find((o) => o.ms === timeoutMs)?.label ?? `${Math.round(timeoutMs / 1000)}s`;
  const hue = hueOf(selectedAI);
  // featuresConfig: which pills this AI declares. Perplexity isn't in AI_FEATURES so this is
  // undefined for it; we render zero pills in that case (Perplexity stays parked).
  const featuresConfig = AI_FEATURES[selectedAI];
  const currentAIOptions = aiOptions[selectedAI] ?? {};
  // wired: does this AI's content-script applyOptions actually do anything yet? Drives the
  // "tool toggles wire up in a later session" caption. ChatGPT=true in Session 1; others flip
  // true in their own sessions.
  const wired = FEATURES_WIRED[selectedAI];

  // Close dropdowns on outside click. One listener handles all three regions — AI dropdown,
  // timeout pill, and the per-AI pills container — so the bottom row stays tidy.
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (timeoutRef.current && !timeoutRef.current.contains(e.target as Node)) {
        setTimeoutOpen(false);
      }
      if (pillsContainerRef.current && !pillsContainerRef.current.contains(e.target as Node)) {
        setOpenPillKey(null);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Close any open per-AI pill when the user switches AI — the new AI's pill set is likely
  // different and a stale open state would render as "phantom dropdown attached to nothing".
  useEffect(() => {
    setOpenPillKey(null);
  }, [selectedAI]);

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

  function handleAISelect(ai: AIModel) {
    onSwitchAI(ai);
    setDropdownOpen(false);
  }

  // handlePillOptionClick: applies the click to the per-AI options store. For single-select
  // pills (the default), clicking the already-active option deselects it (toggle-off behavior,
  // matches ChatGPT's Tools popover). For multi-select pills (future-proofing — none today),
  // toggle membership in the string[] array. Skills pill is comingSoon so its options can't be
  // clicked, but defend anyway.
  function handlePillOptionClick(slot: keyof AIFeatureConfig, pill: AIFeaturePill, optId: string, optComingSoon?: boolean) {
    if (pill.comingSoon || optComingSoon) return;
    if (slot === 'skills') return; // skills is render-only for now
    const writableSlot = slot as SelectableSlot;
    if (pill.multiSelect) {
      const cur = currentAIOptions[writableSlot];
      const arr = Array.isArray(cur) ? cur : cur ? [cur as string] : [];
      const next = arr.includes(optId) ? arr.filter((x) => x !== optId) : [...arr, optId];
      onAIOptionChange(selectedAI, writableSlot, next.length ? next : undefined);
    } else {
      const cur = currentAIOptions[writableSlot];
      const curStr = Array.isArray(cur) ? cur[0] : cur;
      onAIOptionChange(selectedAI, writableSlot, curStr === optId ? undefined : optId);
    }
    setOpenPillKey(null);
  }

  // isOptionActive: read the active state for one option row in a pill's dropdown. Handles both
  // single- and multi-select shapes from currentAIOptions.
  function isOptionActive(slot: keyof AIFeatureConfig, pill: AIFeaturePill, optId: string): boolean {
    if (slot === 'skills') return false;
    const cur = currentAIOptions[slot as SelectableSlot];
    if (cur === undefined) return false;
    if (pill.multiSelect) {
      const arr = Array.isArray(cur) ? cur : [cur as string];
      return arr.includes(optId);
    }
    const curStr = Array.isArray(cur) ? cur[0] : (cur as string);
    return curStr === optId;
  }

  // activePillLabel: short label shown on the pill trigger button. For single-select with a
  // value, show the chosen option's label. For multi-select with values, show "N selected".
  // Otherwise show the pill's default label (e.g. "Tools", "Model").
  function activePillLabel(slot: keyof AIFeatureConfig, pill: AIFeaturePill): string {
    if (slot === 'skills') return pill.label;
    const cur = currentAIOptions[slot as SelectableSlot];
    if (cur === undefined) return pill.label;
    if (pill.multiSelect) {
      const arr = Array.isArray(cur) ? cur : [cur as string];
      if (arr.length === 0) return pill.label;
      if (arr.length === 1) {
        const o = pill.options.find((x) => x.id === arr[0]);
        return o?.label ?? pill.label;
      }
      return `${arr.length} selected`;
    }
    const curStr = Array.isArray(cur) ? cur[0] : (cur as string);
    const o = pill.options.find((x) => x.id === curStr);
    return o?.label ?? pill.label;
  }

  // pillIsActive: should the trigger button render in active hue tint? True when any option is
  // selected for this slot. Skills (coming-soon) never reads as active.
  function pillIsActive(slot: keyof AIFeatureConfig, pill: AIFeaturePill): boolean {
    if (slot === 'skills' || pill.comingSoon) return false;
    const cur = currentAIOptions[slot as SelectableSlot];
    if (cur === undefined) return false;
    if (Array.isArray(cur)) return cur.length > 0;
    return Boolean(cur);
  }

  // pillsToRender: the slot keys this AI declares, in PILL_ORDER. Empty array when Compare is
  // on (per-AI pills hidden) or for AIs without a featuresConfig (e.g. Perplexity).
  const pillsToRender: (keyof AIFeatureConfig)[] = compareMode || !featuresConfig
    ? []
    : PILL_ORDER.filter((k) => featuresConfig[k] !== undefined);

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

            {/* Per-AI pills container. Hidden entirely when Compare is on — Compare is a
                baseline shootout, per-AI tools/models don't apply. The container itself is the
                click-outside region for all pills (see useEffect above). */}
            <div ref={pillsContainerRef} className="flex items-center shrink-0" style={{ gap: 4 }}>
              {pillsToRender.map((slot) => {
                const pill = featuresConfig![slot]!;
                const active = pillIsActive(slot, pill);
                const label = activePillLabel(slot, pill);
                const isOpen = openPillKey === slot;
                const disabledPill = pill.comingSoon === true;
                return (
                  <div key={slot} className="relative shrink-0">
                    <button
                      onClick={() => {
                        if (disabledPill) return;
                        setOpenPillKey(isOpen ? null : slot);
                      }}
                      disabled={loading || disabledPill}
                      title={disabledPill ? `${pill.label} — coming soon` : pill.label}
                      className="flex items-center transition-colors disabled:opacity-50"
                      style={{
                        gap: 7,
                        padding: '7px 11px',
                        borderRadius: 9,
                        color: active ? hue : 'var(--mid)',
                        background: active ? tint(hue, 0.08) : 'transparent',
                        border: 'none',
                        fontSize: 12.5,
                        cursor: disabledPill ? 'not-allowed' : 'pointer',
                        opacity: disabledPill ? 0.5 : 1,
                      }}
                    >
                      <PillIcon slot={slot} />
                      <span>{label}</span>
                      {disabledPill && (
                        <span className="font-mono" style={{ fontSize: 9.5, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                          soon
                        </span>
                      )}
                    </button>

                    {isOpen && !disabledPill && (
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
                        {pill.options.map((opt) => {
                          const optActive = isOptionActive(slot, pill, opt.id);
                          const optDisabled = opt.comingSoon === true;
                          return (
                            <button
                              key={opt.id}
                              onClick={() => handlePillOptionClick(slot, pill, opt.id, opt.comingSoon)}
                              disabled={optDisabled}
                              className="w-full text-left transition-colors flex items-center justify-between"
                              style={{
                                padding: '8px 12px',
                                gap: 8,
                                fontSize: 13,
                                color: optDisabled ? 'var(--faint)' : optActive ? hue : 'var(--mid)',
                                background: optActive && !optDisabled ? tint(hue, 0.08) : 'transparent',
                                border: 'none',
                                borderRadius: 8,
                                cursor: optDisabled ? 'not-allowed' : 'pointer',
                              }}
                            >
                              <span>{opt.label}</span>
                              {optDisabled ? (
                                <span className="font-mono" style={{ fontSize: 9.5, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                  soon
                                </span>
                              ) : optActive ? (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                  <polyline points="20 6 9 17 4 12" />
                                </svg>
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
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

            {/* Compare AI standalone button — sits between the Timeout pill and the AI switcher.
                Always visible (one of Wrapperr's flagship features), reads as active in the
                provider hue when compareMode is on. Clicking flips parent compareMode. The
                AI-switcher dropdown to the right still swaps to a "Compare" badge while on. */}
            <button
              onClick={() => onToggleCompare?.()}
              disabled={loading || compareLocked}
              title={compareMode ? 'Compare AI · click to switch off' : 'Compare AI — fan out to multiple models'}
              className="flex items-center shrink-0 transition-colors disabled:opacity-50"
              style={{
                gap: 7,
                padding: '7px 11px',
                borderRadius: 9,
                marginRight: 4,
                color: compareMode ? hue : 'var(--mid)',
                background: compareMode ? tint(hue, 0.08) : 'transparent',
                border: 'none',
                fontSize: 12.5,
                cursor: compareLocked ? 'not-allowed' : 'pointer',
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
              <span>Compare</span>
            </button>

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

        {/* Stub-UX caption — when the selected AI has pills declared but its applyOptions isn't
            wired yet (FEATURES_WIRED[ai] === false), tell the user the toggles are cosmetic.
            Drops out automatically when each AI's session ships and flips its FEATURES_WIRED to
            true. Hidden during Compare since pills are hidden too. */}
        {!compareMode && featuresConfig && !wired && pillsToRender.length > 0 && (
          <div
            className="font-mono text-center"
            style={{ fontSize: 10.5, color: 'var(--faint)', marginTop: 4 }}
          >
            tool toggles for {currentAI.label} wire up in a later session
          </div>
        )}

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
