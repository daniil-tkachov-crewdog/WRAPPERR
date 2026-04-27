'use client';

import Link from 'next/link';
import { useRouter, usePathname } from 'next/navigation';
import type { ChatSummary } from '@/lib/types';

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
  const router = useRouter();
  const pathname = usePathname();
  const isSettings = pathname?.startsWith('/settings');

  function handleSettings() {
    router.push('/settings');
  }

  function handleNewChat() {
    if (isSettings) router.push('/');
    onNewChat();
  }

  return (
    <div className="flex flex-col h-full w-60 bg-surface border-r border-border shrink-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-border">
        <Link href="/" className="text-xl font-bold tracking-widest text-white hover:opacity-80 transition-opacity">
          WRAPPERR
        </Link>
      </div>

      {/* Action buttons */}
      <div className="px-3 pt-3 pb-2 space-y-1">
        <button
          onClick={handleNewChat}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-muted hover:text-white hover:bg-white/5 transition-colors text-left"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <path d="M7.5 1v13M1 7.5h13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          New Chat
        </button>

        <button
          onClick={() => {}}
          className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm text-muted hover:text-white hover:bg-white/5 transition-colors text-left opacity-50 cursor-not-allowed"
          title="Coming soon"
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <rect x="1" y="1" width="13" height="13" rx="2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M4 5h7M4 7.5h5M4 10h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          Projects
          <span className="ml-auto text-xs bg-purple-600/20 text-purple-400 px-1.5 py-0.5 rounded text-[10px]">
            soon
          </span>
        </button>
      </div>

      {/* Chat history */}
      <div className="flex-1 overflow-y-auto px-3 pb-2">
        {isLoggedIn && chats.length > 0 && (
          <div className="mt-2">
            <p className="px-3 text-[10px] font-medium text-muted uppercase tracking-wider mb-1">
              Recent
            </p>
            {chats.map((chat) => (
              <button
                key={chat.id}
                onClick={() => {
                  if (isSettings) router.push('/');
                  onSelectChat(chat.id);
                }}
                className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors truncate ${
                  currentChatId === chat.id
                    ? 'bg-white/10 text-white'
                    : 'text-muted hover:text-white hover:bg-white/5'
                }`}
              >
                {chat.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Settings */}
      <div className="px-3 pb-3 border-t border-border pt-3">
        <button
          onClick={handleSettings}
          className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg text-sm transition-colors text-left ${
            isSettings
              ? 'bg-white/10 text-white'
              : 'text-muted hover:text-white hover:bg-white/5'
          }`}
        >
          <svg width="15" height="15" viewBox="0 0 15 15" fill="none">
            <circle cx="7.5" cy="7.5" r="2" stroke="currentColor" strokeWidth="1.2"/>
            <path d="M7.5 1.5v1M7.5 12.5v1M1.5 7.5h1M12.5 7.5h1M3.2 3.2l.7.7M11.1 11.1l.7.7M11.8 3.2l-.7.7M3.9 11.1l-.7.7" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          Settings
        </button>
      </div>
    </div>
  );
}
