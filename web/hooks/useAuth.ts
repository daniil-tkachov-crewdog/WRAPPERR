'use client';

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';

// useAuth: client hook exposing the current Supabase user + a loading flag. Loading starts true
// and flips false after the initial getSession() resolves, so callers can gate their UI between
// "still checking" and "definitely logged out". Don't use this for SSR — server pages should
// read the session via lib/supabase/server.ts instead.
export function useAuth() {
  // Local user state. Null = either signed out or initial probe hasn't returned yet — check
  // `loading` to disambiguate before redirecting.
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const supabase = createClient();

    // Initial session probe. Resolves with the cookie-backed session if one is valid; updates
    // both `user` and `loading` so consumers can render their first real frame.
    supabase.auth.getSession().then(({ data: { session } }) => {
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Live subscription to auth state changes (login, logout, token refresh from middleware).
    // Note: does NOT touch `loading` — that's strictly the initial-probe flag.
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setUser(session?.user ?? null);
      }
    );

    // Cleanup: tear the subscription down on unmount to avoid setState on stale instances during
    // fast nav / HMR.
    return () => subscription.unsubscribe();
  }, []);

  return { user, loading };
}
