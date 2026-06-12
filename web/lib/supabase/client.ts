import { createBrowserClient } from '@supabase/ssr';

// Browser-side Supabase client factory. Safe to call repeatedly — @supabase/ssr caches the
// underlying instance per page load. Pair with middleware.ts for token refresh: this client
// alone will not renew an expired access token.
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
