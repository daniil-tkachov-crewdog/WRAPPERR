'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User } from '@supabase/supabase-js';
import type { Profile } from '@/lib/types';
import { createClient } from '@/lib/supabase/client';

interface Props {
  user: User;
  profile: Profile;
  onProfileUpdate: (updated: Partial<Profile>) => void;
}

export default function AccountTab({ user, profile, onProfileUpdate }: Props) {
  const router = useRouter();
  const [name, setName] = useState(profile.name);
  const [savingName, setSavingName] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  async function handleSaveName() {
    if (name === profile.name) return;
    setSavingName(true);
    const supabase = createClient();
    await supabase
      .from('profiles')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', profile.id);
    onProfileUpdate({ name });
    setSavingName(false);
  }

  async function handleDeleteAccount() {
    setDeleting(true);
    const supabase = createClient();
    await supabase.rpc('delete_user');
    await supabase.auth.signOut();
    router.push('/login');
  }

  return (
    <div className="space-y-8 max-w-md">
      <h2 className="text-base font-semibold text-white">Account</h2>

      <div className="space-y-5">
        {/* Name */}
        <div>
          <label className="block text-sm text-muted mb-2">Name</label>
          <div className="flex gap-2">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={handleSaveName}
              placeholder="Your name"
              className="flex-1 bg-surface border border-border rounded-lg px-3 py-2.5 text-white text-sm outline-none focus:border-white/30 transition-colors placeholder-muted"
            />
            {name !== profile.name && (
              <button
                onClick={handleSaveName}
                disabled={savingName}
                className="bg-white text-black text-sm font-medium px-4 py-2 rounded-lg hover:opacity-90 transition-opacity disabled:opacity-40 shrink-0"
              >
                {savingName ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        </div>

        {/* Email */}
        <div>
          <label className="block text-sm text-muted mb-2">Email</label>
          <div className="bg-surface border border-border rounded-lg px-3 py-2.5 text-muted text-sm select-all">
            {user.email}
          </div>
          <p className="text-xs text-muted mt-1.5">Email address cannot be changed.</p>
        </div>
      </div>

      {/* Delete Account */}
      <div className="pt-4 border-t border-border">
        <p className="text-sm font-medium text-white mb-1">Delete account</p>
        <p className="text-xs text-muted mb-4">
          Permanently delete your account and all associated data. This cannot be undone.
        </p>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="bg-red-600/15 border border-red-500/30 text-red-400 text-sm font-medium px-4 py-2 rounded-lg hover:bg-red-600/25 transition-colors"
          >
            Delete account
          </button>
        ) : (
          <div className="bg-red-600/10 border border-red-500/30 rounded-xl p-4 space-y-3">
            <p className="text-sm text-red-300">
              Are you sure? This will permanently delete your account, chat history, and all stored data.
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleDeleteAccount}
                disabled={deleting}
                className="bg-red-600 text-white text-sm font-medium px-4 py-2 rounded-lg hover:bg-red-700 transition-colors disabled:opacity-40"
              >
                {deleting ? 'Deleting…' : 'Yes, delete permanently'}
              </button>
              <button
                onClick={() => setShowDeleteConfirm(false)}
                className="text-sm text-muted hover:text-white transition-colors px-4 py-2"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
