'use client';

import { useEffect, useRef, useState } from 'react';
import type { Message } from '@/lib/types';
import { AI_MODELS } from '@/lib/constants';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';

interface Props {
  message: Message;
  onAskAbout?: (text: string) => void;
}

// MessageBubble: renders chat messages and exposes two interactions.
//   - Copy: small icon button under every bubble copies the raw message content.
//   - Ask about it: only on assistant bubbles. When the user highlights text inside the bubble,
//     a floating button appears near the selection. Clicking it sends the highlighted text up
//     via onAskAbout; the parent then prepends it as a Markdown blockquote to the next message
//     so the AI sees the quoted context. Position is recomputed on selectionchange; the popover
//     hides on scroll/click-elsewhere because re-positioning during scroll would require a
//     popper library we don't need.
// User messages: plain text. Assistant messages: Markdown with GFM + KaTeX, normalized
// provider-side so every AI's styled output renders consistently.
export default function MessageBubble({ message, onAskAbout }: Props) {
  const isUser = message.role === 'user';
  const aiLabel = message.aiModel
    ? AI_MODELS.find((m) => m.id === message.aiModel)?.label
    : undefined;
  const bubbleRef = useRef<HTMLDivElement>(null);
  const [selectionInfo, setSelectionInfo] =
    useState<{ text: string; top: number; left: number } | null>(null);
  const [copied, setCopied] = useState(false);

  // Show: fires when the user releases the mouse inside this bubble after a drag-select. We
  // know the selection is within the bubble because mouseup happened here, so we skip the
  // fragile commonAncestorContainer.contains() check that ReactMarkdown's nested DOM was
  // tripping up. Hide: selectionchange clears the chip when the user clicks elsewhere and
  // the selection collapses. We do NOT hide on scroll — the user may scroll to give the
  // button room or just to inspect; the button gets repositioned via getBoundingClientRect
  // each mouseup, and once they actually click outside the selection collapses anyway.
  function showFromCurrentSelection() {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const text = sel.toString().trim();
    if (!text) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    // Default above the selection; flip below if there isn't room near the viewport top.
    const top = rect.top > 50 ? rect.top - 38 : rect.bottom + 8;
    setSelectionInfo({ text, top, left: rect.left + rect.width / 2 });
  }

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

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-[75%]`}>
        <div
          ref={bubbleRef}
          onMouseUp={!isUser && onAskAbout ? showFromCurrentSelection : undefined}
          className={`${
            isUser
              ? 'bg-white text-black rounded-2xl rounded-tr-sm px-4 py-3'
              : 'bg-surface border border-border text-white rounded-2xl rounded-tl-sm px-4 py-3'
          }`}
        >
          {!isUser && aiLabel && (
            <p className="text-xs text-muted mb-1.5 font-medium">{aiLabel}</p>
          )}
          {isUser ? (
            <p className="text-sm leading-relaxed whitespace-pre-wrap">{message.content}</p>
          ) : (
            <div className="text-sm leading-relaxed wrapperr-md">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkMath]}
                rehypePlugins={[rehypeKatex]}
                components={{
                  a: ({ href, children }) => (
                    <a
                      href={href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-400 underline hover:text-blue-300"
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
        </div>

        {/* Action row: copy button (always) sits under each bubble. */}
        <div className="flex items-center gap-1 mt-1 px-1">
          <button
            onClick={handleCopy}
            title={copied ? 'Copied!' : 'Copy message'}
            className="text-muted hover:text-white transition-colors p-1 rounded"
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

      {/* Floating "Ask about it" popover, only when text is selected inside an assistant bubble.
          Fixed-positioned at the top of the selection rect; translated by -50% so it centers. */}
      {selectionInfo && (
        <button
          onMouseDown={(e) => e.preventDefault() /* don't drop the selection */}
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
