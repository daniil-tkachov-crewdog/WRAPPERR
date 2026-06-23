'use client';

import { useState, useEffect, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import type { Profile, ChatSummary, MemoryUnit } from '@/lib/types';
import { MAX_CHATS } from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';
import { loadMemories, deleteMemory } from '@/lib/memory';
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

// SettingsContent — actual page body, wrapped in Suspense by the default export so
// useSearchParams() doesn't fight Next's SSG export. Each TAB renders a separate component;
// this file is mostly the shell + the auth/profile bootstrap.
function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  // memories: the user's saved memory units, surfaced in the Memory tab. Loaded alongside chats
  // in the bootstrap effect below.
  const [memories, setMemories] = useState<MemoryUnit[]>([]);
  // authState drives which view we show. CRITICAL: we never derive 'anon' from a timeout — that
  // was the "asks me to login until I refresh" bug. When navigating in from the landing page,
  // getSession() and the profile query stall briefly on the @supabase/ssr navigator lock; the
  // old 2s timer fired mid-load, leaving profile null, and the `!user || !profile` gate flashed
  // the login screen. Now: 'loading' shows a spinner, and the login prompt appears ONLY on a
  // definitive no-session result (getSession/subscription returned no user).
  const [authState, setAuthState] = useState<'loading' | 'authed' | 'anon'>('loading');

  const activeTab = (searchParams.get('tab') as Tab) ?? 'general';

  // Session + data bootstrap. We do NOT auto-redirect to /login when there's no session — that
  // created a loop where Settings bounced to login and login bounced back to /. Instead a
  // definitive no-session result renders an inline "Sign in" prompt below.
  //
  // The session can arrive two ways, both wired up so Settings behaves like the landing page:
  //   1. The initial getSession() probe.
  //   2. onAuthStateChange — fires INITIAL_SESSION / SIGNED_IN even when getSession() is slow
  //      (the navigator-lock race seen when navigating in from the landing page).
  // Whichever resolves first wins; the other is a harmless no-op. While neither has answered we
  // stay in 'loading' (spinner), never the login prompt. The 10s timer is ONLY an anti-hang
  // fallback so a truly stuck probe doesn't pin the spinner forever.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // loadData: fetch profile + chats + memories once we know the user id. Kept separate from the
    // auth decision so 'authed' vs 'anon' never waits on these reads.
    async function loadData(userId: string) {
      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .maybeSingle();
      if (cancelled) return;
      if (profileError) console.error('Settings: profile fetch failed:', profileError);
      else if (profileData) setProfile(profileData as Profile);
      else console.error('Settings: no profile row for user', userId);

      const { data: chatData, error: chatError } = await supabase
        .from('chats')
        .select('id, name, ai_model, updated_at')
        .eq('user_id', userId)
        .order('updated_at', { ascending: false })
        .limit(MAX_CHATS);
      if (cancelled) return;
      if (chatError) console.error('Settings: chats fetch failed:', chatError);
      else if (chatData) setChats(chatData as ChatSummary[]);

      // Memory units for the Memory tab. Non-critical — loadMemories logs + returns [] on error.
      const mem = await loadMemories(userId);
      if (cancelled) return;
      setMemories(mem);
    }

    // onSession: single place that turns a session (or its absence) into authState. Both the
    // probe and the live subscription funnel through here.
    function onSession(sessionUser: User | null) {
      if (cancelled) return;
      if (sessionUser) {
        setUser(sessionUser);
        setAuthState('authed');
        loadData(sessionUser.id);
      } else {
        setAuthState('anon');
      }
    }

    supabase.auth.getSession()
      .then(({ data: { session }, error }) => {
        if (error) { console.error('Settings: getSession failed:', error); return; }
        onSession(session?.user ?? null);
      })
      .catch((err) => console.error('Settings: unexpected bootstrap error:', err));

    // Live subscription: catches a session that lands after the probe, so a logged-in user
    // arriving from the landing page hydrates without needing a manual refresh.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => onSession(session?.user ?? null)
    );

    // Anti-hang fallback ONLY: if nothing resolved after 10s, fall back to the logged-out view so
    // the user isn't stuck on a spinner forever. Normally the probe/subscription resolve in well
    // under a second once the navigator lock frees.
    const safety = setTimeout(() => {
      if (!cancelled) setAuthState((s) => (s === 'loading' ? 'anon' : s));
    }, 10000);

    return () => {
      cancelled = true;
      clearTimeout(safety);
      subscription.unsubscribe();
    };
  }, []);

  function handleTabChange(tab: Tab) {
    router.push(`/settings?tab=${tab}`);
  }

  function handleChatDeleted(id: string) {
    setChats((prev) => prev.filter((c) => c.id !== id));
  }

  // handleMemoryDeleted: delete a memory unit in Supabase, then drop it from local state so the
  // list + usage bar update immediately (optimistic, no refetch). RLS scopes the delete to owner.
  async function handleMemoryDeleted(id: string) {
    await deleteMemory(id);
    setMemories((prev) => prev.filter((m) => m.id !== id));
  }

  // Spinner while the session is still resolving, OR while we're authed but the profile row is
  // still loading. We deliberately stay on the spinner here instead of falling through to the
  // login prompt — that prevents the login-screen flash when arriving from the landing page.
  if (authState === 'loading' || (authState === 'authed' && !profile)) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="w-5 h-5 border border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  // Definitive no-session → render an inline "sign in" prompt instead of redirecting. The
  // redirect-to-/login path caused a loop where login → / → click Settings → /login again
  // because the session cookie wasn't visible to this page yet. The extra !user/!profile checks
  // are defensive (and narrow the types for the authed render below).
  if (authState === 'anon' || !user || !profile) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="text-center space-y-4 max-w-sm">
          <p className="text-white text-sm">Sign in to see Settings.</p>
          <a
            href="/login?redirect=/settings"
            className="inline-block bg-white text-black font-medium py-2 px-4 rounded-lg text-sm hover:opacity-90 transition-opacity"
          >
            Go to login
          </a>
          <p className="text-muted text-xs">
            Already signed in? Try refreshing this page, or check the browser console for errors.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-bg overflow-hidden">
      <Sidebar
        chats={chats}
        currentChatId={null}
        onSelectChat={() => router.push('/')}
        onNewChat={() => router.push('/')}
        isLoggedIn={!!user}
        profile={profile}
        email={user?.email ?? null}
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

        {/* Tab content area */}
        <div className="flex-1 overflow-y-auto p-8">
          {activeTab === 'general' && (
            <GeneralTab
              profile={profile}
              onProfileUpdate={(u) => setProfile((p) => p ? { ...p, ...u } : p)}
            />
          )}
          {activeTab === 'commands' && <CommandsTab />}
          {activeTab === 'memory' && (
            <MemoryTab
              memories={memories}
              onMemoryDeleted={handleMemoryDeleted}
              chats={chats}
              onChatDeleted={handleChatDeleted}
            />
          )}
          {activeTab === 'security' && <SecurityTab />}
          {activeTab === 'billing' && <BillingTab />}
          {activeTab === 'account' && (
            <AccountTab
              user={user}
              profile={profile}
              onProfileUpdate={(u) => setProfile((p) => p ? { ...p, ...u } : p)}
            />
          )}
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
