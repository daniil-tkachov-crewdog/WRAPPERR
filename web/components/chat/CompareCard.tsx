'use client';

import { useRef, useState } from 'react';
import type { Message, AIModel } from '@/lib/types';
import { AI_MODELS, hueOf, tint } from '@/lib/constants';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import ProviderMark from './ProviderMark';
import ErrorDisplay from './ErrorDisplay';

interface Props {
  message: Message;
  onRetry: (compareId: string, ai: AIModel) => void;
}

// CompareCard — the swipeable carousel that renders ONE compare-turn message. Three input
// methods are wired so it never feels stuck:
//   1. Tab click on the AI-name strip at the top
//   2. Pagination dot click at the bottom
//   3. Touch swipe (mobile / trackpad gesture) on the slide body
// activeIdx is local state. Index resets are unnecessary — if responses[] reorders we'd have a
// bigger problem; responses are appended in parent-defined order and never reordered.
//
// Per-slide states (status):
//   pending — provider-hued spinner ("waiting for <AI>…")
//   done    — markdown body (reuses .wrapperr-md classes from globals.css for visual parity)
//   error   — red banner + "Retry" button that calls onRetry(compareId, ai)
//
// The card has its own left spine but tints it to the ACTIVE slide's hue, so the spine acts as
// a colour cue while swiping between providers. Tabs above the body double as a header chip per
// provider (mark + label) — clicking a tab switches the slide.
export default function CompareCard({ message, onRetry }: Props) {
  const [activeIdx, setActiveIdx] = useState(0);
  const responses = message.responses ?? [];
  const active = responses[activeIdx];
  const activeMeta = active ? AI_MODELS.find((m) => m.id === active.ai) : null;
  const activeHue = active ? hueOf(active.ai) : 'var(--line)';

  // Touch swipe — capture startX on touchstart, compare to endX on touchend. ≥40 px threshold
  // keeps small drags from misfiring. clamp() prevents index going out of range.
  const touchStartX = useRef<number | null>(null);
  function handleTouchStart(e: React.TouchEvent) {
    touchStartX.current = e.touches[0].clientX;
  }
  function handleTouchEnd(e: React.TouchEvent) {
    if (touchStartX.current === null) return;
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    touchStartX.current = null;
    if (Math.abs(dx) < 40) return;
    setActiveIdx((idx) =>
      Math.max(0, Math.min(responses.length - 1, idx + (dx < 0 ? 1 : -1)))
    );
  }

  if (responses.length === 0) return null;

  return (
    <div className="flex mb-6">
      <div
        style={{
          paddingLeft: 18,
          borderLeft: `2px solid ${tint(activeHue, 0.5)}`,
          maxWidth: '100%',
          width: '100%',
        }}
      >
        {/* Tab strip — one chip per AI in the locked set. Clicking switches the slide. The
            active tab uses the provider hue's tint surface + border; inactive stays neutral. */}
        <div className="flex flex-wrap" style={{ gap: 6, marginBottom: 14 }}>
          {responses.map((r, i) => {
            const meta = AI_MODELS.find((m) => m.id === r.ai);
            const hue = hueOf(r.ai);
            const isActive = i === activeIdx;
            return (
              <button
                key={r.ai}
                onClick={() => setActiveIdx(i)}
                className="flex items-center transition-colors"
                style={{
                  gap: 7,
                  padding: '6px 10px',
                  borderRadius: 9,
                  border: `1px solid ${isActive ? tint(hue, 0.45) : 'var(--line)'}`,
                  background: isActive ? tint(hue, 0.1) : 'transparent',
                  color: isActive ? hue : 'var(--mid)',
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <span style={{ color: hue, display: 'grid', placeItems: 'center' }}>
                  <ProviderMark id={r.ai} size={12} />
                </span>
                <span style={{ fontWeight: isActive ? 580 : 500 }}>{meta?.label ?? r.ai}</span>
                {/* per-status pip — tiny indicator that mirrors the slide state without
                    needing to switch tabs to check progress */}
                {r.status === 'pending' && (
                  <span
                    className="animate-spin"
                    style={{
                      width: 9,
                      height: 9,
                      border: `1.5px solid ${tint(hue, 0.4)}`,
                      borderTopColor: hue,
                      borderRadius: '50%',
                    }}
                  />
                )}
                {r.status === 'error' && (
                  <span style={{ fontSize: 10, color: '#ef6e6e' }}>!</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Slide body — driven by the active response's status. Touch swipe handlers attach
            here so users can drag the answer area. Min-height stops the dots from jumping
            around while a slow AI is still pending. */}
        <div
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          style={{ minHeight: 80 }}
        >
          {active && active.status === 'pending' && (
            <div className="flex items-center" style={{ gap: 10, color: activeHue }}>
              <span
                className="animate-spin"
                style={{
                  width: 12,
                  height: 12,
                  border: `1.5px solid ${tint(activeHue, 0.4)}`,
                  borderTopColor: activeHue,
                  borderRadius: '50%',
                }}
              />
              <span className="font-mono" style={{ fontSize: 12, color: 'var(--mid)' }}>
                waiting for {activeMeta?.label ?? active.ai}…
              </span>
            </div>
          )}

          {active && active.status === 'error' && (
            // Structured WrapperrError takes precedence — full stage / hint / Copy details via
            // ErrorDisplay. Legacy string errors (older in-memory chats from before the
            // overhaul) render with a minimal fallback card so they still surface.
            typeof active.error === 'object' && active.error !== null ? (
              <ErrorDisplay
                error={active.error}
                variant="banner"
                onRetry={() => onRetry(message.id, active.ai)}
                retryLabel="Re-check"
              />
            ) : (
              <div
                style={{
                  background: 'rgba(239, 110, 110, 0.08)',
                  border: '1px solid rgba(239, 110, 110, 0.35)',
                  borderRadius: 12,
                  padding: '12px 14px',
                  color: '#ef9a9a',
                  fontSize: 13,
                  lineHeight: 1.55,
                }}
              >
                <div style={{ marginBottom: 8 }}>
                  <strong style={{ color: '#ef6e6e' }}>{activeMeta?.label ?? active.ai}</strong>{' '}
                  failed: {typeof active.error === 'string' ? active.error : 'unknown error'}
                </div>
                <button
                  onClick={() => onRetry(message.id, active.ai)}
                  style={{
                    background: 'transparent',
                    border: '1px solid rgba(239, 110, 110, 0.5)',
                    color: '#ef9a9a',
                    borderRadius: 8,
                    padding: '5px 11px',
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  Retry
                </button>
              </div>
            )
          )}

          {active && active.status === 'done' && (
            <>
              <div
                className={`wrapperr-md wrapperr-md--bullet-${active.ai}`}
                style={{ fontSize: 14.5, lineHeight: 1.66 }}
              >
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkMath]}
                  rehypePlugins={[rehypeKatex]}
                  components={{
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: activeHue, textDecoration: 'underline' }}
                      >
                        {children}
                      </a>
                    ),
                  }}
                >
                  {active.content}
                </ReactMarkdown>
              </div>

              {/* Recheck button — small reload glyph under each finished response. The capture
                  layer sometimes settles too early (e.g. catches only "Thinking…" or the first
                  partial chunk before the stream completes). Clicking this re-reads the LATEST
                  assistant message directly from the AI's tab (no re-prompt — the AI has by now
                  finished generating in full); swaps this slot to 'pending' until the fresh
                  scrape returns. Different from the error-state Retry button, which uses the
                  same handler — that one just hands off to the same recheck path. */}
              <div className="flex items-center gap-1 mt-2">
                <button
                  onClick={() => onRetry(message.id, active.ai)}
                  title="Re-check response from the AI's tab"
                  className="transition-colors p-1 rounded"
                  style={{ color: 'var(--dim)', background: 'transparent', border: 'none', cursor: 'pointer' }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10" />
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>

        {/* Pagination dots — clickable. Active dot uses the active slide's hue at full alpha;
            others use a faint version of their OWN hue so the row reads as a colour preview. */}
        <div className="flex items-center" style={{ gap: 7, marginTop: 14 }}>
          {responses.map((r, i) => {
            const hue = hueOf(r.ai);
            const isActive = i === activeIdx;
            return (
              <button
                key={r.ai}
                onClick={() => setActiveIdx(i)}
                aria-label={`Show ${r.ai}`}
                style={{
                  width: isActive ? 18 : 7,
                  height: 7,
                  borderRadius: 4,
                  border: 'none',
                  background: isActive ? hue : tint(hue, 0.35),
                  padding: 0,
                  cursor: 'pointer',
                  transition: 'width 160ms',
                }}
              />
            );
          })}
          <span
            className="font-mono"
            style={{ fontSize: 10.5, color: 'var(--faint)', marginLeft: 6 }}
          >
            {activeIdx + 1} / {responses.length}
          </span>
        </div>
      </div>
    </div>
  );
}
