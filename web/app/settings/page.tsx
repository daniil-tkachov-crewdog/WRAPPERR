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

// SettingsContent — actual page body, wrapped in Suspense by the default export so
// useSearchParams() doesn't fight Next's SSG export. Each TAB renders a separate component;
// this file is mostly the shell + the auth/profile bootstrap.
function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const activeTab = (searchParams.get('tab') as Tab) ?? 'general';

  // Session + data bootstrap. If there's no session OR the profile/chats fetch fails, we
  // redirect to /login — the page is auth-gated and should never render with stale or fake
  // data. Errors are logged so we can see them in the dev console instead of being silently
  // masked. The handle_new_user DB trigger guarantees a profiles row exists for every auth
  // user, so a missing profile is a real schema/RLS issue worth surfacing.
  useEffect(() => {
    const supabase = createClient();

    async function getSessionWithRetry() {
      // Dev-mode quirk: parallel HMR/prefetch requests race for the navigator auth lock and
      // one of them gets a "lock stolen" error. Retry once after a brief wait — the lock is
      // released as soon as the winning request finishes its refresh.
      const result = await supabase.auth.getSession();
      if (result.error?.message?.includes('Lock') && result.error.message.includes('stolen')) {
        await new Promise((r) => setTimeout(r, 500));
        return supabase.auth.getSession();
      }
      return result;
    }

    getSessionWithRetry().then(async ({ data: { session }, error: sessionError }) => {
      if (sessionError) {
        console.error('Settings: getSession failed:', sessionError);
        router.replace('/login');
        return;
      }
      if (!session?.user) {
        router.replace('/login');
        return;
      }
      setUser(session.user);

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();
      if (profileError) {
        console.error('Settings: profile fetch failed:', profileError);
        setLoading(false);
        return;
      }
      if (!profileData) {
        // Trigger should have created this row on signup — missing means schema is out of sync.
        console.error('Settings: no profile row for user', session.user.id);
        setLoading(false);
        return;
      }
      setProfile(profileData as Profile);

      const { data: chatData, error: chatError } = await supabase
        .from('chats')
        .select('id, name, ai_model, updated_at')
        .eq('user_id', session.user.id)
        .order('updated_at', { ascending: false })
        .limit(MAX_CHATS);
      if (chatError) {
        console.error('Settings: chats fetch failed:', chatError);
      } else if (chatData) {
        setChats(chatData as ChatSummary[]);
      }

      setLoading(false);
    }).catch((err) => {
      console.error('Settings: unexpected bootstrap error:', err);
      setLoading(false);
    });
  }, [router]);

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

  // After loading, if we still have no profile something broke (logged above). Show a minimal
  // error rather than crashing tabs that assume profile is non-null.
  if (!profile || !user) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg text-white text-sm">
        Couldn&apos;t load your account. Check the console and try refreshing.
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
            <MemoryTab chats={chats} onChatDeleted={handleChatDeleted} />
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
