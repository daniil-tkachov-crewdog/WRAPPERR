'use client';

import { useEffect, useRef, useState } from 'react';
import type { Message } from '@/lib/types';
import { AI_MODELS, hueOf, tint } from '@/lib/constants';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import ProviderMark from './ProviderMark';
import ErrorDisplay from './ErrorDisplay';

interface Props {
  message: Message;
  onAskAbout?: (text: string) => void;
}

// MessageBubble — Spectrum redesign.
// User messages: off-white #f3f4f6 bubble with a tail-bottom-right radius.
// Assistant messages: no bubble — instead, a 2px provider-hued spine on the left and a chip
// above the body (24×24 hued tile + label + mono `<model-id>` metadata). Body keeps the
// existing react-markdown + remark-gfm + KaTeX pipeline. List bullets are tinted to the
// provider hue via the .wrapperr-md--bullet-<id> class on the wrapper.
//
// Interactions are unchanged:
//   - Copy: small button under every bubble copies the raw message content.
//   - Ask about it: assistant-only. When the user highlights text inside the bubble, a floating
//     button appears near the selection. Clicking it sends the highlighted text up via onAskAbout;
//     the parent then prepends it as a Markdown blockquote to the next message so the AI sees the
//     quoted context. Position is recomputed on selectionchange; we hide on click-elsewhere since
//     repositioning during scroll would require a popper library we don't need.
// We don't currently track real latency, so the chip's mono metadata shows only the model id
// (e.g. `claude-3.7`). When latency tracking lands, append it like `claude-3.7 · 0.9s`.
const MODEL_ID_LABELS: Record<string, string> = {
  chatgpt: 'gpt-4o',
  claude: 'claude-3.7',
  grok: 'grok-2',
  gemini: 'gemini-1.5',
  deepseek: 'deepseek-v3',
  perplexity: 'pplx-online',
};

export default function MessageBubble({ message, onAskAbout }: Props) {
  const isUser = message.role === 'user';
  const aiModel = message.aiModel;
  const aiLabel = aiModel ? AI_MODELS.find((m) => m.id === aiModel)?.label : undefined;
  const aiHue = aiModel ? hueOf(aiModel) : undefined;
  const modelMeta = aiModel ? MODEL_ID_LABELS[aiModel] : undefined;
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [selectionInfo, setSelectionInfo] =
    useState<{ text: string; top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);

  // Show: fires on mouseup inside this bubble after a drag-select. We know the selection is
  // inside the bubble because mouseup happened here, so we skip the fragile
  // commonAncestorContainer.contains() check that ReactMarkdown's nested DOM trips up.
  function showFromCurrentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const top = rect.top > 50 ? rect.top - 38 : rect.bottom + 8;
    setSelectionInfo({ text, top, left: rect.left + rect.width / 2 });
  }

  // Hide: selectionchange clears the chip when the user clicks elsewhere and the selection
  // collapses. We do NOT hide on scroll — the user may scroll to give the button room; the
  // button is repositioned via getBoundingClientRect on each mouseup, and once they click
  // outside the selection collapses anyway.
  useEffect(() => {
    if (isUser || !onAskAbout) return;
    function handleSelectionChange() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) setSelectionInfo(null);
    }
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => document.removeEventListener('selectionchange', handleSelectionChange);
  }, [isUser, onAskAbout]);

  function handleCopy() {
    navigator.clipboard.writeText(message.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleAskAbout() {
    if (!selectionInfo) return;
    onAskAbout?.(selectionInfo.text);
    window.getSelection()?.removeAllRanges();
    setSelectionInfo(null);
  }

  // ── User branch ───────────────────────────────────────────────────────────
  // Off-white bubble, dark text, right-aligned, bottom-right tail. Copy button sits beneath.
  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="flex flex-col items-end" style={{ maxWidth: '78%' }}>
          <div
            style={{
              background: '#f3f4f6',
              color: '#111',
              borderRadius: '16px 16px 5px 16px',
              padding: '12px 16px',
              fontSize: 14.5,
              lineHeight: 1.55,
            }}
          >
            <p className="whitespace-pre-wrap">{message.content}</p>
          </div>
          <div className="flex items-center gap-1 mt-1 px-1">
            <button
              onClick={handleCopy}
              title={copied ? 'Copied!' : 'Copy message'}
              className="transition-colors p-1 rounded"
              style={{ color: 'var(--dim)' }}
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Assistant branch ─────────────────────────────────────────────────────
  // No bubble. Provider-hued spine on the left, chip above the body, markdown body inside.
  // The selection-popover is rendered after, fixed-positioned at the selection rect.
  const bulletClass = aiModel ? `wrapperr-md--bullet-${aiModel}` : '';

  return (
    <div className="flex mb-6">
      <div
        ref={bubbleRef}
        onMouseUp={onAskAbout ? showFromCurrentSelection : undefined}
        style={{
          paddingLeft: 18,
          borderLeft: `2px solid ${aiHue ? tint(aiHue, 0.5) : 'var(--line)'}`,
          maxWidth: '100%',
          width: '100%',
        }}
      >
        {aiModel && aiLabel && (
          <div className="flex items-center" style={{ gap: 9, marginBottom: 12 }}>
            <span
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background: aiHue ? tint(aiHue, 0.14) : 'transparent',
                border: `1px solid ${aiHue ? tint(aiHue, 0.3) : 'var(--line)'}`,
                display: 'grid',
                placeItems: 'center',
                color: aiHue,
              }}
            >
              <ProviderMark id={aiModel} size={14} />
            </span>
            <span style={{ fontSize: 12.5, fontWeight: 580, color: 'var(--text)' }}>{aiLabel}</span>
            {modelMeta && (
              <span className="font-mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>
                {modelMeta}
              </span>
            )}
          </div>
        )}

        {/* Body: structured error variant takes precedence over markdown. When the prompt
            round-trip failed at any step (extension absent, tab open failed, applyOptions
            selector miss, poll timeout, etc.), page.tsx attaches the WrapperrError onto the
            assistant message instead of a stringified content. ErrorDisplay renders the
            stage + message + hint and exposes the Copy-details paste block. */}
        {message.wrapperrError ? (
          <ErrorDisplay error={message.wrapperrError} variant="bubble" />
        ) : (
          <div
            className={`wrapperr-md ${bulletClass}`}
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
                    style={{ color: aiHue ?? 'var(--text)', textDecoration: 'underline' }}
                  >
                    {children}
                  </a>
                ),
              }}
            >
              {message.content}
            </ReactMarkdown>
          </div>
        )}

        {/* Action row: copy button. */}
        <div className="flex items-center gap-1 mt-2">
          <button
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy message'}
            className="transition-colors p-1 rounded"
            style={{ color: 'var(--dim)' }}
          >
            {copied ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            )}
          </button>
        </div>
      </div>

      {/* Floating "Ask about it" popover. Fixed-positioned at the top of the selection rect;
          translated -50% to center horizontally. onMouseDown preventDefault preserves the
          selection while the click fires. */}
      {selectionInfo && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={handleAskAbout}
          style={{
            position: 'fixed',
            top: selectionInfo.top,
            left: selectionInfo.left,
            transform: 'translateX(-50%)',
            zIndex: 50,
          }}
          className="bg-white text-black text-xs font-medium px-3 py-1.5 rounded-full shadow-lg hover:bg-gray-100 transition-colors flex items-center gap-1.5"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          Ask about it
        </button>
      )}
    </div>
  );
}
