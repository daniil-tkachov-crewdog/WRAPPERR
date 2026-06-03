'use client';

import type { AIModel } from '@/lib/types';
import { AI_MODELS, tint, hueOf } from '@/lib/constants';
import ProviderMark from './ProviderMark';

// RelayCard — the signature handoff event, rendered persistently in the message stream at the
// point a model switch happened. ActiveChatState derives the insertion point by comparing each
// assistant message's aiModel against the previous assistant message's aiModel; if they differ
// it slots a <RelayCard from={prev} to={current}/> in between.
// We don't currently track token counts or summary text, so the footer line stays generic. If
// handleSwitchAI later records the summary token count on the relayed message, pass it in via
// `note` and it will show in the footer instead.
interface Props {
  from: AIModel;
  to: AIModel;
  note?: string;
}

export default function RelayCard({ from, to, note }: Props) {
  const fromHue = hueOf(from);
  const toHue = hueOf(to);
  const fromLabel = AI_MODELS.find((m) => m.id === from)?.label ?? from;
  const toLabel = AI_MODELS.find((m) => m.id === to)?.label ?? to;

  return (
    <div className="my-6">
      <div
        style={{
          position: 'relative',
          borderRadius: 14,
          padding: '15px 18px',
          overflow: 'hidden',
          background: `linear-gradient(100deg, ${tint(fromHue, 0.1)}, ${tint(toHue, 0.1)})`,
          border: '1px solid var(--line)',
        }}
      >
        {/* Top row: [fromTile] From — connector with mono "context relayed" — To [toTile]. */}
        <div className="flex items-center" style={{ gap: 14 }}>
          <div className="flex items-center" style={{ gap: 8 }}>
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: tint(fromHue, 0.16),
                display: 'grid',
                placeItems: 'center',
                color: fromHue,
              }}
            >
              <ProviderMark id={from} size={13} />
            </span>
            <span style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 560 }}>{fromLabel}</span>
          </div>
          <div className="flex items-center" style={{ flex: 1, gap: 6 }}>
            <span
              style={{
                flex: 1,
                height: 1.5,
                background: `linear-gradient(90deg, ${tint(fromHue, 0.6)}, ${tint(toHue, 0.6)})`,
                borderRadius: 2,
              }}
            />
            <span
              className="font-mono"
              style={{
                fontSize: 10.5,
                color: 'var(--mid)',
                whiteSpace: 'nowrap',
                padding: '0 2px',
              }}
            >
              context relayed
            </span>
            <span
              style={{
                flex: 1,
                height: 1.5,
                background: `linear-gradient(90deg, ${tint(fromHue, 0.6)}, ${tint(toHue, 0.6)})`,
                borderRadius: 2,
              }}
            />
          </div>
          <div className="flex items-center" style={{ gap: 8 }}>
            <span style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 560 }}>{toLabel}</span>
            <span
              style={{
                width: 22,
                height: 22,
                borderRadius: 6,
                background: tint(toHue, 0.16),
                display: 'grid',
                placeItems: 'center',
                color: toHue,
              }}
            >
              <ProviderMark id={to} size={13} />
            </span>
          </div>
        </div>
        {/* Footer: short mono summary. Defaults to a generic line because we don't track token
            counts; pass `note` from the parent to override. */}
        <div
          className="font-mono"
          style={{
            fontSize: 11.5,
            color: 'var(--dim)',
            marginTop: 9,
            paddingTop: 9,
            borderTop: '1px solid var(--line-soft)',
          }}
        >
          {note ?? `context summary relayed to ${toLabel}`}
        </div>
      </div>
    </div>
  );
}
