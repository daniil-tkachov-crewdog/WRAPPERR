'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

type Mode = 'signin' | 'signup' | 'magic' | 'forgot';

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  function switchMode(next: Mode) {
    setMode(next);
    setError('');
    setPassword('');
    setConfirmPassword('');
    setShowPassword(false);
    setShowConfirm(false);
  }

  // Email + password sign-in. On success redirect to app. Common failure: account was created
  // via magic link and has no password set — user should use "Forgot password?" to set one.
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

  // Sign-up creates a new account. Supabase sends a confirmation email unless disabled in
  // the dashboard. The handle_new_user trigger auto-creates the profile row on auth.users insert.
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
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    });

    if (sbError) {
      setError(sbError.message);
      setLoading(false);
    } else {
      setMessage('Check your email to confirm your account, then sign in.');
      setLoading(false);
    }
  }

  // Sends a password reset / set link. Works for both forgotten passwords and accounts that were
  // created via magic link and never had a password. The link redirects to /auth/reset via callback.
  async function handleForgot(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error: sbError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      redirectTo: `${window.location.origin}/auth/callback?next=/auth/reset`,
    });

    if (sbError) {
      setError(sbError.message);
      setLoading(false);
    } else {
      setSent(true);
      setLoading(false);
    }
  }

  // Magic link — original OTP flow kept as secondary option.
  async function handleMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error: sbError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
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

  // Inline SVG eye icons — no icon library required.
  const EyeIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.477 0 8.268 2.943 9.542 7-1.274 4.057-5.065 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
    </svg>
  );

  const EyeOffIcon = () => (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.477 0-8.268-2.943-9.542-7a9.97 9.97 0 012.12-3.584M6.53 6.53A9.97 9.97 0 0112 5c4.477 0 8.268 2.943 9.542 7a9.97 9.97 0 01-4.343 5.229M15 12a3 3 0 00-3-3m0 6a3 3 0 01-2.83-2M3 3l18 18" />
    </svg>
  );

  function PasswordInput({
    value, onChange, placeholder, show, onToggle,
  }: {
    value: string;
    onChange: (v: string) => void;
    placeholder: string;
    show: boolean;
    onToggle: () => void;
  }) {
    return (
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required
          className={inputClass + ' pr-11'}
        />
        <button
          type="button"
          onClick={onToggle}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-white transition-colors"
          tabIndex={-1}
        >
          {show ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      </div>
    );
  }

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
            <button className="text-white text-xs underline mt-4" onClick={() => { setMessage(''); switchMode('signin'); }}>
              Back to sign in
            </button>
          </div>
        ) : sent ? (
          <div className="text-center space-y-3">
            <p className="text-white font-medium">Check your email</p>
            <p className="text-muted text-sm">
              {mode === 'forgot'
                ? <>We sent a password reset link to <span className="text-white">{email}</span>.</>
                : <>We sent a login link to <span className="text-white">{email}</span>.</>}
            </p>
            <button className="text-white text-xs underline mt-4" onClick={() => { setSent(false); switchMode('signin'); }}>
              Back to sign in
            </button>
          </div>
        ) : mode === 'magic' ? (
          <form onSubmit={handleMagicLink} className="space-y-4">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" required className={inputClass} />
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
        ) : mode === 'forgot' ? (
          <form onSubmit={handleForgot} className="space-y-4">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" required className={inputClass} />
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button type="submit" disabled={loading || !email.trim()} className={btnPrimary}>
              {loading ? 'Sending…' : 'Send reset link'}
            </button>
            <p className="text-center text-muted text-xs">
              <button type="button" onClick={() => switchMode('signin')} className="hover:text-white transition-colors">
                Back to sign in
              </button>
            </p>
          </form>
        ) : (
          <form onSubmit={mode === 'signin' ? handleSignIn : handleSignUp} className="space-y-4">
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="your@email.com" required className={inputClass} />
            <PasswordInput value={password} onChange={setPassword} placeholder="Password" show={showPassword} onToggle={() => setShowPassword((s) => !s)} />
            {mode === 'signup' && (
              <PasswordInput value={confirmPassword} onChange={setConfirmPassword} placeholder="Confirm password" show={showConfirm} onToggle={() => setShowConfirm((s) => !s)} />
            )}
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button type="submit" disabled={loading || !email.trim() || !password} className={btnPrimary}>
              {loading ? '…' : mode === 'signin' ? 'Sign in' : 'Sign up'}
            </button>
            <div className="flex items-center justify-between text-xs text-muted">
              <div className="flex flex-col gap-1">
                {mode === 'signin' ? (
                  <>
                    <button type="button" onClick={() => switchMode('signup')} className="hover:text-white transition-colors text-left">New here? Sign up</button>
                    <button type="button" onClick={() => switchMode('forgot')} className="hover:text-white transition-colors text-left">Forgot password?</button>
                  </>
                ) : (
                  <button type="button" onClick={() => switchMode('signin')} className="hover:text-white transition-colors text-left">Already have an account?</button>
                )}
              </div>
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
