'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import type { ChatSummary } from '@/lib/types';
import { hueOf } from '@/lib/constants';
import ProviderMark from '@/components/chat/ProviderMark';

// Sidebar — Spectrum redesign.
// Five sections from top to bottom:
//   1. Wordmark — gradient tile (conic through the provider hues) + WRAPPERR text.
//   2. New chat + Search chats rows.
//   3. Recents grouped under a "Today" mono label, each row tinted with its provider's hue.
//   4. Account footer with avatar, name, mono sub-line, settings gear.
// Behaviour is unchanged: same props, same handlers, same routing. Only the chrome changes.
// Note on "Search chats": purely visual placeholder, no logic yet — kept to match the design.

interface Props {
  chats: ChatSummary[];
  currentChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  isLoggedIn: boolean;
}

export default function Sidebar({
  chats,
  currentChatId,
  onSelectChat,
  onNewChat,
  isLoggedIn,
}: Props) {
  // Routing context. isSettings drives both the gear's active treatment and "bounce back to
  // the chat surface" when New chat / a recent is clicked from /settings.
  const router = useRouter();
  const pathname = usePathname();
  const isSettings = pathname?.startsWith('/settings');

  // Navigation handlers. handleNewChat bridges /settings → / so the user lands on the chat
  // surface in the new-thread state instead of seeing onNewChat fire on an unmounted tree.
  function handleSettings() {
    router.push('/settings');
  }

  function handleNewChat() {
    if (isSettings) router.push('/');
    onNewChat();
  }

  return (
    <aside
      className="flex flex-col h-full shrink-0"
      style={{ width: 268, background: 'var(--rail)', borderRight: '1px solid var(--line)' }}
    >
      {/* 1. Wordmark row. The 23×23 conic-gradient tile cycles through the Spectrum provider
          hues; a 9px dot in --rail is punched in the centre so it reads as a logo mark, not
          just a coloured swatch. */}
      <div className="flex items-center" style={{ padding: '21px 20px 16px', gap: 10 }}>
        <Link href="/" className="flex items-center hover:opacity-80 transition-opacity" style={{ gap: 10 }}>
          <span
            style={{
              width: 23,
              height: 23,
              borderRadius: 7,
              flexShrink: 0,
              background:
                'conic-gradient(from 210deg, oklch(0.74 0.12 165), oklch(0.76 0.13 55), oklch(0.70 0.13 255), oklch(0.68 0.15 288), oklch(0.74 0.12 165))',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--rail)' }} />
          </span>
          <span style={{ fontSize: 14.5, fontWeight: 600, letterSpacing: '0.24em', color: 'var(--text)' }}>
            WRAPPERR
          </span>
        </Link>
      </div>

      {/* 2. New chat + Search chats. New chat is the filled --panel button with the ⌘N hint.
          Search chats is a ghost row, placeholder for a future feature — clicking does nothing. */}
      <div style={{ padding: '0 12px 8px' }}>
        <button
          onClick={handleNewChat}
          className="w-full flex items-center transition-colors hover:opacity-90"
          style={{
            gap: 11,
            padding: '10px 12px',
            borderRadius: 10,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            color: 'var(--text)',
            fontSize: 13.5,
            fontWeight: 520,
            cursor: 'pointer',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
          New chat
          <span className="font-mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--dim)' }}>
            ⌘N
          </span>
        </button>
        <button
          type="button"
          disabled
          title="Coming soon"
          className="w-full flex items-center cursor-not-allowed"
          style={{
            gap: 11,
            padding: '9px 12px',
            marginTop: 4,
            borderRadius: 9,
            color: 'var(--dim)',
            fontSize: 13.5,
            background: 'transparent',
            border: 'none',
          }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4-4" />
          </svg>
          Search chats
        </button>
      </div>

      {/* 3. Recents. Section label "Today" in mono, then one row per chat. The provider mark on
          the left is tinted with that chat's signature hue. The active chat gets --raise bg and
          --text colour. Hover lifts the row slightly. */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px 0' }}>
        {isLoggedIn && chats.length > 0 && (
          <>
            <div
              className="font-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.13em',
                textTransform: 'uppercase',
                color: 'var(--faint)',
                padding: '6px 12px 8px',
                fontWeight: 600,
              }}
            >
              Today
            </div>
            {chats.map((chat) => {
              const active = currentChatId === chat.id;
              const hue = hueOf(chat.ai_model);
              return (
                <button
                  key={chat.id}
                  onClick={() => {
                    if (isSettings) router.push('/');
                    onSelectChat(chat.id);
                  }}
                  className="w-full flex items-center transition-colors"
                  style={{
                    gap: 10,
                    padding: '8.5px 12px',
                    borderRadius: 9,
                    background: active ? 'var(--raise)' : 'transparent',
                    color: active ? 'var(--text)' : 'var(--mid)',
                    fontSize: 13,
                    border: 'none',
                    textAlign: 'left',
                    cursor: 'pointer',
                  }}
                  onMouseEnter={(e) => {
                    if (!active) e.currentTarget.style.background = 'rgba(255,255,255,0.06)';
                  }}
                  onMouseLeave={(e) => {
                    if (!active) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <span style={{ flexShrink: 0, color: hue }}>
                    <ProviderMark id={chat.ai_model} size={14} />
                  </span>
                  <span
                    style={{
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: 1,
                    }}
                  >
                    {chat.name}
                  </span>
                </button>
              );
            })}
          </>
        )}
      </div>

      {/* 4. Account footer / login slot. Logged in → the account bar (avatar + name + plan +
          settings gear), unchanged from the original design. Logged out → a single Log In button
          fills the same footer slot, matching the screenshot where login replaces the Settings
          bar. Routing the button to /login reuses the existing auth page. The isLoggedIn switch
          is the only behavioural change here; the logged-in branch is byte-for-byte as before. */}
      {isLoggedIn ? (
        <div
          className="flex items-center"
          style={{ borderTop: '1px solid var(--line)', padding: 12, gap: 10 }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: 'linear-gradient(150deg,#3a3a3d,#202022)',
              border: '1px solid var(--line)',
              flexShrink: 0,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12.5, color: 'var(--text)', fontWeight: 520, lineHeight: 1.1 }}>
              Daniil T.
            </div>
            <div className="font-mono" style={{ fontSize: 10.5, color: 'var(--dim)' }}>
              Pro · 5 providers linked
            </div>
          </div>
          <button
            onClick={handleSettings}
            title="Settings"
            className="transition-colors"
            style={{
              width: 26,
              height: 26,
              display: 'grid',
              placeItems: 'center',
              background: 'transparent',
              border: 'none',
              color: isSettings ? 'var(--text)' : 'var(--dim)',
              cursor: 'pointer',
              borderRadius: 7,
            }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
              <circle cx="12" cy="12" r="2.6" />
              <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
            </svg>
          </button>
        </div>
      ) : (
        <div style={{ borderTop: '1px solid var(--line)', padding: 12 }}>
          <button
            onClick={() => router.push('/login')}
            className="w-full flex items-center justify-center transition-colors hover:opacity-90"
            style={{
              gap: 8,
              padding: '10px 12px',
              borderRadius: 10,
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              color: 'var(--text)',
              fontSize: 13.5,
              fontWeight: 520,
              cursor: 'pointer',
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
            </svg>
            Log In
          </button>
        </div>
      )}
    </aside>
  );
}
