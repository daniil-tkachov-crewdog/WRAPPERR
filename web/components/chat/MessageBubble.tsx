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
  // onSaveToMemory: persist text to the user's personal memory. Used by the "Save to Memory"
  // action button (saves the whole message) and the right-click popup (saves the highlighted
  // selection). Returns the outcome so the UI can flash "Saved" / "Limit reached". See
  // page.tsx addMemory + lib/memory.ts.
  onSaveToMemory?: (text: string) => Promise<'saved' | 'limit' | 'error'>;
}

// SaveToMemoryButton — the action-row button that saves a full message to memory.
// Click flow (per product spec):
//   bookmark → spinner (while the save is in flight) → green check "Done" (~2s) → bookmark.
//   On failure → red cross (~2.5s); the parent (addMemory in page.tsx) additionally raises the
//   standard Wrapperr error banner. The spinner stays up until onSaveToMemory resolves, which only
//   happens after Supabase confirms the row AND the in-app memories state (Settings tab source) is
//   updated. Renders nothing when onSaveToMemory isn't provided (e.g. logged-out surfaces).
function SaveToMemoryButton({
  getText,
  onSaveToMemory,
}: {
  getText: () => string;
  onSaveToMemory?: (text: string) => Promise<'saved' | 'limit' | 'error'>;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  if (!onSaveToMemory) return null;

  async function handle() {
    // Ignore re-clicks while a save is in flight so the spinner isn't interrupted.
    if (state === 'loading') return;
    const text = getText().trim();
    if (!text) return;
    setState('loading');
    try {
      const result = await onSaveToMemory!(text);
      if (result === 'saved') {
        setState('done');
        setTimeout(() => setState('idle'), 2000);
      } else {
        // 'limit' / 'error' — addMemory has already surfaced the Wrapperr error banner.
        setState('error');
        setTimeout(() => setState('idle'), 2500);
      }
    } catch {
      // Defensive: addMemory shouldn't throw, but never leave the button stuck on the spinner.
      setState('error');
      setTimeout(() => setState('idle'), 2500);
    }
  }

  const title =
    state === 'loading'
      ? 'Saving…'
      : state === 'done'
      ? 'Saved to memory!'
      : state === 'error'
      ? 'Save failed'
      : 'Save to memory';
  const color = state === 'done' ? '#34d399' : state === 'error' ? '#f87171' : 'var(--dim)';

  return (
    <button
      onClick={handle}
      disabled={state === 'loading'}
      title={title}
      className="transition-colors p-1 rounded"
      style={{ color }}
    >
      {state === 'loading' ? (
        // Spinner while saving.
        <span
          className="animate-spin"
          style={{
            display: 'inline-block',
            width: 14,
            height: 14,
            border: '1.5px solid var(--line)',
            borderTopColor: 'var(--text)',
            borderRadius: '50%',
          }}
        />
      ) : state === 'done' ? (
        // Green check = saved confirmation.
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : state === 'error' ? (
        // Red cross = save failed (banner carries the detail).
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      ) : (
        // Outline bookmark = default.
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
        </svg>
      )}
    </button>
  );
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

export default function MessageBubble({ message, onAskAbout, onSaveToMemory }: Props) {
  const isUser = message.role === 'user';
  const aiModel = message.aiModel;
  const aiLabel = aiModel ? AI_MODELS.find((m) => m.id === aiModel)?.label : undefined;
  const aiHue = aiModel ? hueOf(aiModel) : undefined;
  const modelMeta = aiModel ? MODEL_ID_LABELS[aiModel] : undefined;
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [selectionInfo, setSelectionInfo] =
    useState<{ text: string; top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);
  // contextMenu: the right-click "Save to Memory" popup. Holds the highlighted text plus the
  // cursor position to render at. Null when hidden. Works on both user and assistant messages.
  const [contextMenu, setContextMenu] =
    useState<{ text: string; x: number; y: number } | null>(null);

  // handleContextMenu: on right-click, if the user has a non-empty text selection we suppress the
  // native browser menu and show our own "Save to Memory" popup at the cursor. If there's no
  // selection we let the default menu through (so right-click still works normally elsewhere).
  function handleContextMenu(e: React.MouseEvent) {
    if (!onSaveToMemory) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text) return;
    e.preventDefault();
    setContextMenu({ text, x: e.clientX, y: e.clientY });
  }

  // handleSaveSelection: persist the highlighted text from the context-menu popup, then clear the
  // selection and close the popup. Feedback for partial saves is intentionally light (the popup
  // just disappears); the per-button flash is reserved for the full-message Save button.
  async function handleSaveSelection() {
    if (!contextMenu) return;
    await onSaveToMemory?.(contextMenu.text);
    window.getSelection()?.removeAllRanges();
    setContextMenu(null);
  }

  // Dismiss the context-menu popup on any outside click or scroll. Mirrors the existing
  // selectionchange cleanup used by the "Ask about it" popover. Registered only while the popup
  // is open to avoid needless global listeners.
  useEffect(() => {
    if (!contextMenu) return;
    function close() {
      setContextMenu(null);
    }
    document.addEventListener('mousedown', close);
    document.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('scroll', close, true);
    };
  }, [contextMenu]);

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

  // contextMenuPopup — the right-click "Save to Memory" popup, shared by both branches. Fixed at
  // the cursor; onMouseDown preventDefault keeps the selection alive while the click fires (the
  // outside-click listener uses mousedown to dismiss). zIndex above the chat.
  const contextMenuPopup = contextMenu && (
    <button
      onMouseDown={(e) => e.preventDefault()}
      onClick={handleSaveSelection}
      style={{
        position: 'fixed',
        top: contextMenu.y,
        left: contextMenu.x,
        zIndex: 60,
      }}
      className="bg-white text-black text-xs font-medium px-3 py-1.5 rounded-lg shadow-lg hover:bg-gray-100 transition-colors flex items-center gap-1.5"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />
      </svg>
      Save to Memory
    </button>
  );

  // ── User branch ───────────────────────────────────────────────────────────
  // Off-white bubble, dark text, right-aligned, bottom-right tail. Copy + Save buttons sit beneath.
  // onContextMenu enables the right-click "Save to Memory" popup over highlighted text.
  if (isUser) {
    return (
      <div className="flex justify-end mb-4">
        <div className="flex flex-col items-end" style={{ maxWidth: '78%' }} onContextMenu={handleContextMenu}>
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
            {/* Save the whole message to memory. */}
            <SaveToMemoryButton getText={() => message.content} onSaveToMemory={onSaveToMemory} />
          </div>
        </div>
        {contextMenuPopup}
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
        onContextMenu={handleContextMenu}
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

        {/* Action row: copy + save-to-memory buttons. */}
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
          {/* Save the whole assistant response to memory. */}
          <SaveToMemoryButton getText={() => message.content} onSaveToMemory={onSaveToMemory} />
        </div>
      </div>

      {contextMenuPopup}

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
