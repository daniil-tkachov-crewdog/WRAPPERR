import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

// OAuth / magic-link callback handler. Supabase redirects the browser here with a `code` query
// param after the external auth flow completes. We exchange the code for a session cookie and
// then bounce to `next` (defaults to the app root). NEXT_PUBLIC_APP_URL pins the origin in
// production so the redirect isn't spoofed by a forwarded Host header — falls back to the
// request URL's own origin in dev. Any failure dumps the user to /login with ?error=auth.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const next = searchParams.get('next') ?? '/';

  const origin = process.env.NEXT_PUBLIC_APP_URL ?? new URL(request.url).origin;

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  return NextResponse.redirect(`${origin}/login?error=auth`);
}
