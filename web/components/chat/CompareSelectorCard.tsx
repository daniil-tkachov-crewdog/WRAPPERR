'use client';

import type { AIModel } from '@/lib/types';
import { AI_MODELS, tint } from '@/lib/constants';
import ProviderMark from './ProviderMark';

interface Props {
  selected: AIModel[];
  onToggle: (ai: AIModel) => void;
}

// CompareSelectorCard — in-thread block where the user picks ≥2 AIs before the first Compare
// send. Sits where the next assistant message would appear, so picking AIs feels like setting up
// the "panel" that will answer. After the first Compare send the parent hides this card
// (compareLocked === true) and the chosen set is frozen for the rest of the chat.
//
// Visual: neutral panel surface, no left spine (this isn't a real AI reply yet). Header reads
// "Compare AI" with a hint line. Then a 6-button grid — each button tinted with its provider hue
// when selected. Perplexity is shown disabled (comingSoon) to match the single-AI dropdown.
// Footer hint changes when ≥2 picked → "Type your message to fan out to N AIs".
export default function CompareSelectorCard({ selected, onToggle }: Props) {
  const canSend = selected.length >= 2;

  return (
    <div className="mb-6">
      <div
        style={{
          background: 'var(--panel)',
          border: '1px dashed var(--line)',
          borderRadius: 14,
          padding: '14px 16px',
        }}
      >
        {/* Header row — Compare label + small hint about minimum picks. */}
        <div className="flex items-center" style={{ gap: 9, marginBottom: 12 }}>
          <span
            style={{
              width: 24,
              height: 24,
              borderRadius: 7,
              background: 'var(--raise)',
              border: '1px solid var(--line)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--text)',
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </span>
          <span style={{ fontSize: 12.5, fontWeight: 580, color: 'var(--text)' }}>Compare AI</span>
          <span className="font-mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>
            pick at least 2
          </span>
        </div>

        {/* AI button row — wraps on narrow viewports. Each button toggles via onToggle.
            Selected state tints background+border+text with the provider hue. Perplexity is
            unclickable (comingSoon) and shows a "soon" tag. */}
        <div className="flex flex-wrap" style={{ gap: 8 }}>
          {AI_MODELS.map((m) => {
            const isOn = selected.includes(m.id);
            const disabled = !!m.comingSoon;
            return (
              <button
                key={m.id}
                onClick={() => !disabled && onToggle(m.id)}
                disabled={disabled}
                className="flex items-center transition-colors"
                style={{
                  gap: 7,
                  padding: '7px 11px',
                  borderRadius: 10,
                  border: `1px solid ${
                    disabled ? 'var(--line)' : isOn ? tint(m.hue, 0.45) : 'var(--line)'
                  }`,
                  background: isOn ? tint(m.hue, 0.1) : 'transparent',
                  color: disabled ? 'var(--faint)' : isOn ? m.hue : 'var(--mid)',
                  fontSize: 12.5,
                  cursor: disabled ? 'not-allowed' : 'pointer',
                  opacity: disabled ? 0.55 : 1,
                }}
              >
                <span style={{ color: m.hue, display: 'grid', placeItems: 'center' }}>
                  <ProviderMark id={m.id} size={13} />
                </span>
                <span>{m.label}</span>
                {disabled && (
                  <span className="font-mono" style={{ fontSize: 10, color: 'var(--faint)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                    soon
                  </span>
                )}
                {isOn && (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </button>
            );
          })}
        </div>

        {/* Footer hint — switches from "pick more" to "ready" once ≥2 selected. */}
        <div
          className="font-mono"
          style={{ fontSize: 11, color: 'var(--faint)', marginTop: 12 }}
        >
          {canSend
            ? `ready — type a message to fan out to ${selected.length} AIs in parallel`
            : 'select two or more to enable sending'}
        </div>
      </div>
    </div>
  );
}
