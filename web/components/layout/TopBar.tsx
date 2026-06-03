'use client';

import { AI_MODELS } from '@/lib/constants';
import ProviderMark from '@/components/chat/ProviderMark';

// TopBar: a 56px header above the message list. Shows the current chat title on the left and a
// `providers` mono-label + overlapping avatar stack of the linked (non-coming-soon) providers
// on the right. Purely presentational — no behaviour bound to the avatar tiles for now; they
// communicate "this app speaks to all these models". chatName comes from the parent (derived
// from the chats list in page.tsx).
interface Props {
  chatName?: string;
}

export default function TopBar({ chatName }: Props) {
  // Linked = every provider not flagged comingSoon. Currently 5 of 6 (Perplexity is parked).
  const linked = AI_MODELS.filter((m) => !m.comingSoon);

  return (
    <div
      className="flex items-center px-6 shrink-0"
      style={{ height: 56, borderBottom: '1px solid var(--line-soft)', gap: 14 }}
    >
      <div style={{ fontSize: 13.5, color: 'var(--text)', fontWeight: 540 }}>
        {chatName || 'New chat'}
      </div>
      <div style={{ flex: 1 }} />
      <span
        className="font-mono"
        style={{ fontSize: 10.5, color: 'var(--dim)' }}
      >
        providers
      </span>
      {/* Avatar stack: each tile overlaps the previous by 6px and gets a 2px --bg ring so the
          overlap reads as separation rather than fusion. */}
      <div className="flex items-center">
        {linked.map((m, i) => (
          <span
            key={m.id}
            title={m.label}
            style={{
              width: 24,
              height: 24,
              borderRadius: 7,
              background: 'var(--raise)',
              border: '1px solid var(--line)',
              display: 'grid',
              placeItems: 'center',
              color: m.hue,
              marginLeft: i ? -6 : 0,
              boxShadow: '0 0 0 2px var(--bg)',
            }}
          >
            <ProviderMark id={m.id} size={12} />
          </span>
        ))}
      </div>
    </div>
  );
}
