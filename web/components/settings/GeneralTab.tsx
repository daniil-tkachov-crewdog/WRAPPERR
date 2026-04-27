'use client';

import { useState } from 'react';
import type { AIModel, AppearanceMode, Profile } from '@/lib/types';
import { AI_MODELS } from '@/lib/constants';
import { createClient } from '@/lib/supabase/client';

interface Props {
  profile: Profile;
  onProfileUpdate: (updated: Partial<Profile>) => void;
}

export default function GeneralTab({ profile, onProfileUpdate }: Props) {
  const [saving, setSaving] = useState(false);
  const [appearance, setAppearance] = useState<AppearanceMode>(profile.appearance);
  const [defaultAI, setDefaultAI] = useState<AIModel>(profile.default_ai);

  async function handleSave() {
    setSaving(true);
    const supabase = createClient();
    await supabase
      .from('profiles')
      .update({ appearance, default_ai: defaultAI, updated_at: new Date().toISOString() })
      .eq('id', profile.id);
    onProfileUpdate({ appearance, default_ai: defaultAI });
    setSaving(false);
  }

  const isDirty = appearance !== profile.appearance || defaultAI !== profile.default_ai;

  return (
    <div className="space-y-8 max-w-md">
      <div>
        <h2 className="text-base font-semibold text-white mb-6">General</h2>

        <div className="space-y-5">
          <div>
            <label className="block text-sm text-muted mb-2">Appearance</label>
            <select
              value={appearance}
              onChange={(e) => setAppearance(e.target.value as AppearanceMode)}
              className="w-full bg-surface border border-border rounded-lg px-3 py-2.5 text-white text-sm outline-none focus:border-white/30 transition-colors"
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">System</option>
            </select>
          </div>

          <div>
            <label className="block text-sm text-muted mb-2">Default AI model</label>
            <select
              value={defaultAI}
              onChange={(e) => setDefaultAI(e.target.value as AIModel)}
              className="w-full bg-surface border border-border rounded-lg px-3 py-2.5 text-white text-sm outline-none focus:border-white/30 transition-colors"
            >
              {AI_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {isDirty && (
        <button
          onClick={handleSave}
          disabled={saving}
          className="bg-white text-black font-medium px-5 py-2 rounded-lg text-sm hover:opacity-90 transition-opacity disabled:opacity-40"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      )}
    </div>
  );
}
