'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import type { Profile, ChatSummary } from '@/lib/types';
import { MAX_CHATS } from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';
import Sidebar from '@/components/layout/Sidebar';
import GeneralTab from '@/components/settings/GeneralTab';
import CommandsTab from '@/components/settings/CommandsTab';
import MemoryTab from '@/components/settings/MemoryTab';
import SecurityTab from '@/components/settings/SecurityTab';
import BillingTab from '@/components/settings/BillingTab';
import AccountTab from '@/components/settings/AccountTab';

type Tab = 'general' | 'commands' | 'memory' | 'security' | 'billing' | 'account';

// TABS: top-level Settings categories rendered in the left nav. Source of truth for the URL
// ?tab= param too — keep IDs stable or you'll break old bookmarks.
const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'commands', label: 'Commands' },
  { id: 'memory', label: 'Memory' },
  { id: 'security', label: 'Security' },
  { id: 'billing', label: 'Billing' },
  { id: 'account', label: 'Account' },
];

// PLACEHOLDER_PROFILE: dummy Profile fed to tab components when there's no real Supabase
// session. Mirrors the shape of a real row so existing tabs render fields without crashing.
// Used together with the `placeholderMode` flag, which disables interaction at the wrapper
// level — nothing here is ever written back to Supabase.
const PLACEHOLDER_PROFILE: Profile = {
  id: 'placeholder',
  name: '',
  default_ai: 'chatgpt',
  appearance: 'dark',
};

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  // placeholderMode: true when we couldn't establish a real Supabase session (or the profile/
  // chat fetch failed). UI still renders fully but all inputs are visually frozen via a
  // pointer-events-none / reduced-opacity wrapper around the tab content. Save buttons are
  // unreachable so nothing tries to hit Supabase from a tab. Flip this off once Supabase auth
  // and RLS issues are sorted, and the page will go back to fully interactive.
  const [placeholderMode, setPlaceholderMode] = useState(false);

  const activeTab = (searchParams.get('tab') as Tab) ?? 'general';

  // Session + data bootstrap. Previously bailed to /login on any auth failure; now we instead
  // drop into placeholderMode so the user can still navigate the Settings UI even when
  // Supabase is misbehaving (the original reason this page was "disabled").
  useEffect(() => {
    const supabase = createClient();

    async function getSessionWithRetry() {
      const result = await supabase.auth.getSession();
      if (result.error?.message?.includes('Lock') && result.error.message.includes('stolen')) {
        await new Promise((r) => setTimeout(r, 500));
        return supabase.auth.getSession();
      }
      return result;
    }

    getSessionWithRetry().then(async ({ data: { session }, error: sessionError }) => {
      if (sessionError || !session?.user) {
        // No real session — render the page in placeholder mode with a dummy profile so the
        // tab components still mount. No redirects, no Supabase writes.
        setProfile(PLACEHOLDER_PROFILE);
        setPlaceholderMode(true);
        setLoading(false);
        return;
      }
      setUser(session.user);

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();
      if (profileError || !profileData) {
        // Profile fetch broken (RLS / schema / etc.) — fall back to placeholder rather than
        // showing the red error banner that used to live here.
        setProfile(PLACEHOLDER_PROFILE);
        setPlaceholderMode(true);
        setLoading(false);
        return;
      }
      setProfile(profileData as Profile);

      const { data: chatData } = await supabase
        .from('chats')
        .select('id, name, ai_model, updated_at')
        .eq('user_id', session.user.id)
        .order('updated_at', { ascending: false })
        .limit(MAX_CHATS);
      if (chatData) setChats(chatData as ChatSummary[]);

      setLoading(false);
    }).catch(() => {
      // Unexpected throw — same fallback path. The page must never be inaccessible just
      // because Supabase is unreachable.
      setProfile(PLACEHOLDER_PROFILE);
      setPlaceholderMode(true);
      setLoading(false);
    });
  }, [router]); // eslint-disable-line react-hooks/exhaustive-deps

  function handleTabChange(tab: Tab) {
    router.push(`/settings?tab=${tab}`);
  }

  function handleChatDeleted(id: string) {
    setChats((prev) => prev.filter((c) => c.id !== id));
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="w-5 h-5 border border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  // effectiveProfile/effectiveUser: in placeholder mode we hand the tabs dummy values so they
  // render. AccountTab is gated on a real `user` so we only show it when we have one.
  const effectiveProfile = profile ?? PLACEHOLDER_PROFILE;

  return (
    <div className="flex h-screen bg-bg overflow-hidden">
      <Sidebar
        chats={chats}
        currentChatId={null}
        onSelectChat={() => router.push('/')}
        onNewChat={() => router.push('/')}
        isLoggedIn={!!user}
      />

      <main className="flex-1 flex min-w-0">
        {/* Settings tabs nav */}
        <div className="w-44 border-r border-border py-6 px-3 shrink-0">
          <p className="px-3 text-[10px] font-medium text-muted uppercase tracking-wider mb-3">
            Settings
          </p>
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => handleTabChange(tab.id)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm mb-0.5 transition-colors ${
                activeTab === tab.id
                  ? 'bg-white/10 text-white'
                  : 'text-muted hover:text-white hover:bg-white/5'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Tab content area. In placeholderMode we wrap the content in a non-interactive,
            dimmed container and show a banner explaining why nothing reacts. */}
        <div className="flex-1 overflow-y-auto p-8">
          {placeholderMode && (
            <div className="mb-6 p-3 bg-amber-500/10 border border-amber-500/30 rounded-xl text-xs text-amber-300/90 max-w-2xl">
              Settings are currently shown as read-only placeholders while we resolve Supabase
              auth and storage issues. Fields and tabs are visible for layout reference, but
              edits won&apos;t persist.
            </div>
          )}

          <div
            className={
              placeholderMode
                ? 'pointer-events-none opacity-60 select-none'
                : ''
            }
            aria-disabled={placeholderMode}
          >
            {activeTab === 'general' && (
              <GeneralTab
                profile={effectiveProfile}
                onProfileUpdate={(u) => setProfile((p) => p ? { ...p, ...u } : p)}
              />
            )}
            {activeTab === 'commands' && <CommandsTab />}
            {activeTab === 'memory' && (
              <MemoryTab chats={chats} onChatDeleted={handleChatDeleted} />
            )}
            {activeTab === 'security' && <SecurityTab />}
            {activeTab === 'billing' && <BillingTab />}
            {activeTab === 'account' && (
              // AccountTab needs a real user object (email, id) to render. In placeholder mode
              // we synthesise a minimal stub so the tab still mounts with empty values.
              <AccountTab
                user={user ?? ({ id: 'placeholder', email: 'placeholder@example.com' } as User)}
                profile={effectiveProfile}
                onProfileUpdate={(u) => setProfile((p) => p ? { ...p, ...u } : p)}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="w-5 h-5 border border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    }>
      <SettingsContent />
    </Suspense>
  );
}
