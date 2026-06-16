import { createClient } from '@/lib/supabase/client';
import { MEMORY_CHAR_LIMIT } from '@/lib/constants';
import type { MemoryUnit } from '@/lib/types';

// lib/memory.ts — all Supabase access for the personal memory feature, plus the prompt-injection
// formatter. Centralised here so the chat flow (page.tsx) and the Settings Memory tab share one
// implementation. Uses the browser Supabase client; RLS guarantees each user only ever touches
// their own rows, so we never have to filter defensively beyond passing user_id on insert.

// totalChars: sum of all saved memory characters. This is what we measure against
// MEMORY_CHAR_LIMIT — the budget is the combined size of everything stored, because the whole set
// is what gets injected into a prompt.
export function totalChars(units: MemoryUnit[]): number {
  return units.reduce((sum, u) => sum + u.memory_unit.length, 0);
}

// loadMemories: fetch all of the user's memory units, oldest-first so the Settings numbering
// (1..n) is stable as new items are appended. Returns [] on error (memory is non-critical — a
// failed load must never block the chat UI).
export async function loadMemories(userId: string): Promise<MemoryUnit[]> {
  const supabase = createClient();
  const { data, error } = await supabase
    .from('memories')
    .select('id, memory_unit, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) {
    console.error('loadMemories error:', error);
    return [];
  }
  return (data as MemoryUnit[]) ?? [];
}

// insertMemory: save one new memory unit after trimming. Two client-side guards before hitting
// the DB: (1) reject empty text, (2) reject if adding it would push the running total over
// MEMORY_CHAR_LIMIT. The caller passes the current units so we don't need an extra round-trip to
// re-sum. Returns the created row on success so the caller can update local state without a
// refetch. The `reason` on failure drives the UI feedback ("Limit reached" vs generic error).
export async function insertMemory(
  userId: string,
  text: string,
  currentUnits: MemoryUnit[]
): Promise<{ ok: true; unit: MemoryUnit } | { ok: false; reason: 'empty' | 'limit' | 'error' }> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, reason: 'empty' };

  // Limit check: the new total must fit the budget. We check here (not the DB) — see schema.sql.
  if (totalChars(currentUnits) + trimmed.length > MEMORY_CHAR_LIMIT) {
    return { ok: false, reason: 'limit' };
  }

  const supabase = createClient();
  const { data, error } = await supabase
    .from('memories')
    .insert({ user_id: userId, memory_unit: trimmed })
    .select('id, memory_unit, created_at')
    .single();

  if (error || !data) {
    console.error('insertMemory error:', error);
    return { ok: false, reason: 'error' };
  }
  return { ok: true, unit: data as MemoryUnit };
}

// deleteMemory: remove one unit by id. RLS scopes the delete to the owner, so no user_id filter
// is needed. Errors are logged, not thrown — the caller does optimistic local removal.
export async function deleteMemory(id: string): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.from('memories').delete().eq('id', id);
  if (error) console.error('deleteMemory error:', error);
}

// buildMemoryInjection: compose the string actually sent to an AI when memory is injected. The
// user's chat bubble still shows the ORIGINAL input — this wrapped form only goes over the
// extension bridge. Format (per spec): a one-line framing instruction so the model treats the
// block as persistent context, then USER_MEMORY as a JSON array, then the real INPUT. Only call
// this when there is at least one memory unit (caller guards on units.length).
export function buildMemoryInjection(units: MemoryUnit[], input: string): string {
  const memoryJson = JSON.stringify(units.map((u) => u.memory_unit));
  return (
    `The following USER_MEMORY is persistent context the user has saved about themselves across ` +
    `AI sessions. Use it to personalise your answer when relevant, but do not mention it unless ` +
    `asked. Then respond to INPUT.\n\n` +
    `USER_MEMORY: ${memoryJson}\n` +
    `INPUT: "${input}"`
  );
}
