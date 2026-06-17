import { createBrowserClient } from '@supabase/ssr';

// Browser-side Supabase client factory. Safe to call repeatedly — @supabase/ssr caches the
// underlying instance per page load.
//
// Session lifetime: the Next.js middleware that used to refresh tokens server-side was removed
// (it hung on some networks), so the SPA now keeps itself logged in entirely client-side. The
// auth options below make that explicit — persistSession stores the session in cookies across
// reloads, autoRefreshToken silently renews the access token before it expires (this is what
// prevents the "logged out after a few minutes" symptom), and detectSessionInUrl handles the
// magic-link / OAuth callback hash. These are library defaults, pinned here on purpose so a
// future @supabase/ssr change can't silently disable them. NOTE: the *maximum* session length is
// still governed by the Supabase project's Auth → Sessions settings (inactivity timeout /
// time-box) — code can refresh the token but cannot override a server-side session cap.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    }
  );
}
