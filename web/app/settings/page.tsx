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
  const [loading, setLoading] = useState(true);

  const activeTab = (searchParams.get('tab') as Tab) ?? 'general';

  // Session + data bootstrap. We do NOT auto-redirect to /login when there's no session —
  // that created a loop where Settings bounced to login and login bounced back to /. Instead,
  // a no-session state renders an inline "Sign in to see Settings" prompt below.
  //
  // Two ways the session can arrive, BOTH wired up here so Settings behaves like the landing
  // page (which never spuriously showed the login prompt):
  //   1. The initial getSession() probe.
  //   2. onAuthStateChange — fires INITIAL_SESSION / SIGNED_IN even when getSession() is slow or
  //      hangs (the @supabase/ssr navigator-lock race). Without this subscription, a slow probe
  //      tripped the 2s safety timeout below and rendered "Sign in to see Settings" to a user who
  //      had just logged in on the landing page. This was the root cause of that bug.
  // Hard 2s safety timeout: only flips the spinner off so the user isn't stuck loading forever —
  // if it fires before the session resolves, the subscription still hydrates the page afterwards.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    // hydrate: shared loader for whichever path delivers the session first. Guards against double
    // work (getSession + subscription both firing) via the `user` check, and against setState on
    // an unmounted tree via `cancelled`.
    async function hydrate(session: import('@supabase/supabase-js').Session | null) {
      if (cancelled) return;
      if (!session?.user) {
        setLoading(false);
        return;
      }
      setUser(session.user);

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();
      if (cancelled) return;
      if (profileError) {
        console.error('Settings: profile fetch failed:', profileError);
      } else if (profileData) {
        setProfile(profileData as Profile);
      } else {
        console.error('Settings: no profile row for user', session.user.id);
      }

      const { data: chatData, error: chatError } = await supabase
        .from('chats')
        .select('id, name, ai_model, updated_at')
        .eq('user_id', session.user.id)
        .order('updated_at', { ascending: false })
        .limit(MAX_CHATS);
      if (cancelled) return;
      if (chatError) {
        console.error('Settings: chats fetch failed:', chatError);
      } else if (chatData) {
        setChats(chatData as ChatSummary[]);
      }

      // Memory units for the Memory tab. Non-critical — errors are logged inside loadMemories
      // and it returns [] so the rest of Settings still renders.
      const mem = await loadMemories(session.user.id);
      if (cancelled) return;
      setMemories(mem);
      setLoading(false);
    }

    const safety = setTimeout(() => {
      if (!cancelled) setLoading(false);
    }, 2000);

    supabase.auth.getSession().then(({ data: { session }, error: sessionError }) => {
      clearTimeout(safety);
      if (sessionError) {
        console.error('Settings: getSession failed:', sessionError);
        setLoading(false);
        return;
      }
      hydrate(session);
    }).catch((err) => {
      console.error('Settings: unexpected bootstrap error:', err);
      clearTimeout(safety);
      setLoading(false);
    });

    // Live subscription: catches a session that lands after the probe / safety timeout, so a
    // logged-in user who arrives from the landing page never gets stuck on the login prompt.
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      clearTimeout(safety);
      hydrate(session);
    });

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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="w-5 h-5 border border-white/20 border-t-white rounded-full animate-spin" />
      </div>
    );
  }

  // No session or no profile → render an inline "sign in" prompt instead of redirecting.
  // The redirect-to-/login path caused a loop where login → / → click Settings → /login
  // again because the session cookie wasn't visible to this page yet.
  if (!user || !profile) {
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
