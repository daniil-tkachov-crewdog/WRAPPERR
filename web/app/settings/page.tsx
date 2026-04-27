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

const TABS: { id: Tab; label: string }[] = [
  { id: 'general', label: 'General' },
  { id: 'commands', label: 'Commands' },
  { id: 'memory', label: 'Memory' },
  { id: 'security', label: 'Security' },
  { id: 'billing', label: 'Billing' },
  { id: 'account', label: 'Account' },
];

function SettingsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const activeTab = (searchParams.get('tab') as Tab) ?? 'general';

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(async ({ data: { session }, error: sessionError }) => {
      if (sessionError) {
        setError(`Auth error: ${sessionError.message}`);
        setLoading(false);
        return;
      }
      if (!session?.user) {
        router.push('/login');
        return;
      }
      setUser(session.user);

      const { data: profileData, error: profileError } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', session.user.id)
        .maybeSingle();
      if (profileError) {
        setError(`Failed to load profile: ${profileError.message} (code: ${profileError.code})`);
        setLoading(false);
        return;
      }
      if (profileData) {
        setProfile(profileData as Profile);
      } else {
        const { data: newProfile, error: insertError } = await supabase
          .from('profiles')
          .upsert({ id: session.user.id, name: '', default_ai: 'chatgpt', appearance: 'dark' })
          .select()
          .single();
        if (insertError) {
          setError(`Failed to create profile: ${insertError.message} (code: ${insertError.code})`);
          setLoading(false);
          return;
        }
        if (newProfile) setProfile(newProfile as Profile);
      }

      const { data: chatData, error: chatError } = await supabase
        .from('chats')
        .select('id, name, ai_model, updated_at')
        .eq('user_id', session.user.id)
        .order('updated_at', { ascending: false })
        .limit(MAX_CHATS);
      if (chatError) {
        setError(`Failed to load chats: ${chatError.message} (code: ${chatError.code})`);
        setLoading(false);
        return;
      }
      if (chatData) setChats(chatData as ChatSummary[]);

      setLoading(false);
    }).catch((err: unknown) => {
      setError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
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

  if (error) {
    return (
      <div className="flex items-center justify-center h-screen bg-bg">
        <div className="max-w-md w-full mx-4 p-4 bg-red-600/10 border border-red-500/30 rounded-xl">
          <p className="text-sm font-medium text-red-400 mb-1">Settings failed to load</p>
          <p className="text-xs text-red-300/80 font-mono break-all">{error}</p>
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

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-8">
          {activeTab === 'general' && profile && (
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
          {activeTab === 'account' && user && profile && (
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
