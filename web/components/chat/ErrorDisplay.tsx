'use client';

import { useState } from 'react';
import { formatForCopy, type WrapperrError } from '@/lib/errors';

// ErrorDisplay — the single building block used by ErrorBubble (in chat) and ErrorBanner (top
// of page / auth / settings). Renders:
//   • Stage headline + scope chip
//   • One-line message (always visible)
//   • Optional hint paragraph
//   • Copy details (writes formatForCopy(w) to clipboard — paste straight to Claude / a dev)
//   • Collapsible Technical details with the full JSON (code, requestId, details, cause)
//
// Visual tier (variant): 'bubble' for in-thread assistant errors (no outer card chrome — the
// MessageBubble spine + chip already wrap it), 'banner' for standalone use above a form.
//
// Why a single component instead of two: the headline / copy / expand logic is identical; only
// the outer chrome differs, and that's two style branches not two files.

interface Props {
  error: WrapperrError;
  variant?: 'bubble' | 'banner';
  // Optional Retry — when present, renders a Retry button next to Copy. We don't dictate WHAT
  // retry means; the parent decides (resend the prompt, re-read tab, redo auth call).
  onRetry?: () => void;
  retryLabel?: string;
}

export default function ErrorDisplay({ error, variant = 'bubble', onRetry, retryLabel = 'Retry' }: Props) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(formatForCopy(error)).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  }

  // Card chrome differs per variant. Bubble = transparent inner block (parent draws the spine);
  // banner = the full red-tinted card (used when no parent chrome exists).
  const outerStyle: React.CSSProperties = variant === 'banner'
    ? {
        background: 'rgba(239, 110, 110, 0.07)',
        border: '1px solid rgba(239, 110, 110, 0.3)',
        borderRadius: 12,
        padding: '14px 16px',
      }
    : {
        background: 'rgba(239, 110, 110, 0.06)',
        border: '1px solid rgba(239, 110, 110, 0.28)',
        borderRadius: 12,
        padding: '12px 14px',
      };

  return (
    <div style={outerStyle}>
      {/* Headline: stage + scope chip. The stage is the user-friendly "what step failed". */}
      <div className="flex items-center" style={{ gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
        <span style={{ color: '#ef6e6e', fontWeight: 600, fontSize: 13 }}>
          {error.stage} failed
        </span>
        <span
          className="font-mono"
          style={{
            fontSize: 10,
            color: '#ef9a9a',
            border: '1px solid rgba(239, 110, 110, 0.4)',
            borderRadius: 6,
            padding: '1px 6px',
          }}
        >
          {error.scope}
        </span>
        {error.ai && (
          <span className="font-mono" style={{ fontSize: 10, color: 'var(--dim)' }}>
            {error.ai}
          </span>
        )}
      </div>

      {/* Message: the user-facing one-liner. Comes from the registry; can be overridden at the
          throw site. We keep it short — details live in the expand block. */}
      <div style={{ color: '#ef9a9a', fontSize: 13, lineHeight: 1.55 }}>
        {error.message}
      </div>

      {/* Hint: registry-default suggestion of where to look. Optional — not every error has a
          tractable hint, and "no hint" is better than a generic one. */}
      {error.hint && (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            lineHeight: 1.55,
            color: 'var(--dim)',
            paddingLeft: 10,
            borderLeft: '2px solid rgba(239, 110, 110, 0.35)',
          }}
        >
          {error.hint}
        </div>
      )}

      {/* Action row: Copy (always), Retry (if parent supplied a handler), Expand. The Copy
          button is the headline feature — clicking once dumps a paste-ready WRAPPERR ERROR
          block to the clipboard for sharing with Claude or a dev. */}
      <div className="flex items-center" style={{ gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
        <button
          onClick={handleCopy}
          title="Copy a paste-ready block for Claude / your developer"
          style={{
            background: 'transparent',
            border: '1px solid rgba(239, 110, 110, 0.4)',
            color: '#ef9a9a',
            borderRadius: 8,
            padding: '4px 10px',
            fontSize: 11.5,
            cursor: 'pointer',
          }}
        >
          {copied ? 'Copied' : 'Copy details'}
        </button>
        {onRetry && (
          <button
            onClick={onRetry}
            style={{
              background: 'transparent',
              border: '1px solid rgba(239, 110, 110, 0.4)',
              color: '#ef9a9a',
              borderRadius: 8,
              padding: '4px 10px',
              fontSize: 11.5,
              cursor: 'pointer',
            }}
          >
            {retryLabel}
          </button>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--dim)',
            fontSize: 11.5,
            cursor: 'pointer',
            padding: '4px 4px',
          }}
        >
          {expanded ? 'Hide technical details' : 'Show technical details'}
        </button>
      </div>

      {/* Technical details: the unredacted WrapperrError as JSON. Same content the Copy button
          writes, just shown inline for quick eyeballing without a paste roundtrip. */}
      {expanded && (
        <pre
          className="font-mono"
          style={{
            marginTop: 10,
            background: 'rgba(0, 0, 0, 0.3)',
            border: '1px solid rgba(239, 110, 110, 0.2)',
            borderRadius: 8,
            padding: '10px 12px',
            fontSize: 11,
            lineHeight: 1.5,
            color: 'var(--mid)',
            overflowX: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
          }}
        >
          {formatForCopy(error)}
        </pre>
      )}
    </div>
  );
}
