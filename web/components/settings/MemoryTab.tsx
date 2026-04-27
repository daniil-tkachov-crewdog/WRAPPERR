'use client';

import { useState } from 'react';
import type { ChatSummary } from '@/lib/types';
import { MAX_CHATS } from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';

interface Props {
  chats: ChatSummary[];
  onChatDeleted: (id: string) => void;
}

export default function MemoryTab({ chats, onChatDeleted }: Props) {
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setDeletingId(id);
    const supabase = createClient();
    await supabase.from('chats').delete().eq('id', id);
    onChatDeleted(id);
    setDeletingId(null);
  }

  return (
    <div className="space-y-6 max-w-md">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-white">Memory</h2>
        <span className="text-xs text-muted">{chats.length} / {MAX_CHATS} chats</span>
      </div>

      {chats.length === 0 ? (
        <p className="text-muted text-sm">No saved chats yet.</p>
      ) : (
        <div className="space-y-1">
          {chats.map((chat) => (
            <div
              key={chat.id}
              className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-white/5 group transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <span className="text-sm text-white truncate">{chat.name}</span>
                <span className="text-xs text-muted shrink-0 hidden group-hover:block">
                  {chat.ai_model}
                </span>
              </div>
              <button
                onClick={() => handleDelete(chat.id)}
                disabled={deletingId === chat.id}
                className="text-xs text-red-400 hover:text-red-300 transition-colors ml-4 shrink-0 disabled:opacity-40"
              >
                {deletingId === chat.id ? 'Deleting…' : 'Delete'}
              </button>
            </div>
          ))}
        </div>
      )}

      {chats.length >= MAX_CHATS && (
        <p className="text-amber-400 text-xs">
          You have reached the {MAX_CHATS}-chat limit. Delete some chats to save new ones.
        </p>
      )}
    </div>
  );
}
