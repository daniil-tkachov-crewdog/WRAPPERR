'use client';

import { useState } from 'react';
import type { ChatSummary, MemoryUnit } from '@/lib/types';
import { MAX_CHATS, MEMORY_CHAR_LIMIT } from '@/lib/constants';
import { totalChars } from '@/lib/memory';
import { createClient } from '@/lib/supabase/client';

interface Props {
  // Personal memory units — the primary content of this tab.
  memories: MemoryUnit[];
  onMemoryDeleted: (id: string) => void;
  // Saved chats — TEMPORARY. Chat management lives here until the planned "chat history → sidebar"
  // task moves it. Kept so chat deletion isn't lost in the meantime.
  chats: ChatSummary[];
  onChatDeleted: (id: string) => void;
}

// MemoryTab — the Settings → Memory surface. Top half is the personal memory feature: a usage bar
// showing how much of the MEMORY_CHAR_LIMIT budget is used, then a numbered (1..n) list of saved
// memory units, each deletable. The UUID is intentionally never shown — users see a friendly index.
// Bottom half is the legacy saved-chats list (temporary — see Props.chats).
export default function MemoryTab({ memories, onMemoryDeleted, chats, onChatDeleted }: Props) {
  // deletingId pins whichever row's Delete is in flight (shared across both lists since ids are
  // unique) so we can show "Deleting…" and block double-clicks.
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Usage math for the limit bar. used = sum of all memory characters; pct clamps to 100 so a
  // (client-bypassed) overflow can't blow the bar past full.
  const used = totalChars(memories);
  const pct = Math.min(100, Math.round((used / MEMORY_CHAR_LIMIT) * 100));
  // Bar colour escalates as the budget fills: normal → amber (≥80%) → red (full).
  const barColor = pct >= 100 ? '#f87171' : pct >= 80 ? '#fbbf24' : '#34d399';

  // handleDeleteMemory: optimistic delete of one memory unit (parent does the Supabase call +
  // local state removal). No confirm modal — single-click delete, matching the chats list.
  async function handleDeleteMemory(id: string) {
    setDeletingId(id);
    await onMemoryDeleted(id);
    setDeletingId(null);
  }

  // handleDeleteChat: deletes the chat row in Supabase, then bubbles the id up so the sidebar
  // list re-renders. (Unchanged from the previous Memory tab behaviour.)
  async function handleDeleteChat(id: string) {
    setDeletingId(id);
    const supabase = createClient();
    await supabase.from('chats').delete().eq('id', id);
    onChatDeleted(id);
    setDeletingId(null);
  }

  return (
    <div className="space-y-10 max-w-md">
      {/* ── Personal memory ──────────────────────────────────────────────── */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Memory</h2>
          <span className="text-xs text-muted">
            {used.toLocaleString()} / {MEMORY_CHAR_LIMIT.toLocaleString()} chars
          </span>
        </div>

        {/* Usage bar: how much of the character budget is used. Memory is injected into the first
            prompt of each session, so this is also a rough proxy for context cost. */}
        <div className="w-full bg-white/10 rounded-full h-2 overflow-hidden">
          <div
            className="h-full transition-all"
            style={{ width: `${pct}%`, background: barColor }}
          />
        </div>

        <p className="text-xs text-muted">
          Saved memory is shared with every AI at the start of a new chat and when you switch
          models, so they remember key facts about you.
        </p>

        {memories.length === 0 ? (
          <p className="text-muted text-sm">No memories saved yet. Use the bookmark button under a message, or right-click highlighted text and choose “Save to Memory”.</p>
        ) : (
          <div className="space-y-1">
            {memories.map((unit, idx) => (
              <div
                key={unit.id}
                className="flex items-start justify-between gap-4 py-2.5 px-3 rounded-lg hover:bg-white/5 group transition-colors"
              >
                <div className="flex items-start gap-3 min-w-0">
                  {/* Friendly 1..n index — never the Supabase UUID. */}
                  <span className="text-xs text-muted shrink-0 mt-0.5 tabular-nums">{idx + 1}.</span>
                  <span className="text-sm text-white break-words">{unit.memory_unit}</span>
                </div>
                <button
                  onClick={() => handleDeleteMemory(unit.id)}
                  disabled={deletingId === unit.id}
                  className="text-xs text-red-400 hover:text-red-300 transition-colors shrink-0 disabled:opacity-40"
                >
                  {deletingId === unit.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            ))}
          </div>
        )}

        {used >= MEMORY_CHAR_LIMIT && (
          <p className="text-amber-400 text-xs">
            You have reached the {MEMORY_CHAR_LIMIT.toLocaleString()}-character memory limit. Delete some memory to save more.
          </p>
        )}
      </div>

      {/* ── Saved chats (temporary) ──────────────────────────────────────────
          Chat management lives here until the planned move to the sidebar. Kept so deletion
          isn't lost. Treat as legacy — do not extend this section. */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-white">Saved chats</h3>
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
                  onClick={() => handleDeleteChat(chat.id)}
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
    </div>
  );
}
