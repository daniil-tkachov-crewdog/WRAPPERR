'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Three auth modes: email+password sign-in, email+password sign-up, magic link.
// Default is sign-in. Mode switches are in-page — no separate routes needed.
type Mode = 'signin' | 'signup' | 'magic';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setPassword('');
    setConfirmPassword('');
  }

  // Email + password sign-in via signInWithPassword. On success, Supabase sets the session
  // cookie and we redirect to the app. On failure (wrong password, unconfirmed email, etc.)
  // the error message from Supabase is shown directly.
  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error: sbError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (sbError) {
      setError(sbError.message);
      setLoading(false);
    } else {
      window.location.href = '/';
    }
  }

  // Sign-up creates a new account. Supabase sends a confirmation email; the user must click it
  // before they can sign in. If email confirmation is disabled in the Supabase dashboard the
  // user is signed in immediately. confirmPassword mismatch is validated client-side only.
  async function handleSignUp(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error: sbError } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (sbError) {
      setError(sbError.message);
      setLoading(false);
    } else {
      setMessage('Check your email to confirm your account, then sign in.');
      setLoading(false);
    }
  }

  // Magic link (OTP) — original flow kept as a secondary option. Sends a one-time link to the
  // email; clicking it hits /auth/callback which exchanges the code for a session.
  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error: sbError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
      },
    });

    if (sbError) {
      setError(sbError.message);
      setLoading(false);
    } else {
      setSent(true);
      setLoading(false);
    }
  }

  const inputClass =
    'w-full bg-surface border border-border rounded-lg px-4 py-3 text-white placeholder-muted text-sm outline-none focus:border-white/30 transition-colors';
  const btnPrimary =
    'w-full bg-white text-black font-medium py-3 rounded-lg text-sm transition-opacity disabled:opacity-40 hover:opacity-90';

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-semibold tracking-tight text-white text-center mb-10">
          Wrapperr
        </h1>

        {message ? (
          <div className="text-center space-y-2">
            <p className="text-white font-medium">Almost there</p>
            <p className="text-muted text-sm">{message}</p>
            <button
              className="text-white text-xs underline mt-4"
              onClick={() => { setMessage(''); switchMode('signin'); }}
            >
              Back to sign in
            </button>
          </div>
        ) : sent ? (
          <div className="text-center space-y-3">
            <p className="text-white font-medium">Check your email</p>
            <p className="text-muted text-sm">
              We sent a login link to <span className="text-white">{email}</span>.
            </p>
            <button
              className="text-white text-xs underline mt-4"
              onClick={() => { setSent(false); switchMode('signin'); }}
            >
              Back to sign in
            </button>
          </div>
        ) : mode === 'magic' ? (
          <form onSubmit={handleMagicLink} className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className={inputClass}
            />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button type="submit" disabled={loading || !email.trim()} className={btnPrimary}>
              {loading ? 'Sending…' : 'Send magic link'}
            </button>
            <p className="text-center text-muted text-xs">
              <button type="button" onClick={() => switchMode('signin')} className="hover:text-white transition-colors">
                Sign in with password instead
              </button>
            </p>
          </form>
        ) : (
          <form onSubmit={mode === 'signin' ? handleSignIn : handleSignUp} className="space-y-4">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="your@email.com"
              required
              className={inputClass}
            />
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Password"
              required
              className={inputClass}
            />
            {mode === 'signup' && (
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm password"
                required
                className={inputClass}
              />
            )}
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button
              type="submit"
              disabled={loading || !email.trim() || !password}
              className={btnPrimary}
            >
              {loading ? '…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
            </button>
            <div className="flex items-center justify-between text-xs text-muted">
              {mode === 'signin' ? (
                <button type="button" onClick={() => switchMode('signup')} className="hover:text-white transition-colors">
                  New here? Sign up
                </button>
              ) : (
                <button type="button" onClick={() => switchMode('signin')} className="hover:text-white transition-colors">
                  Already have an account?
                </button>
              )}
              <button type="button" onClick={() => switchMode('magic')} className="hover:text-white transition-colors">
                Use magic link
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
