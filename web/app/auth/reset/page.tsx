'use client';

import { useState } from 'react';
import { createClient } from '@/lib/supabase/client';

// Password reset page. The user lands here after clicking the reset link in their email.
// The /auth/callback route already exchanged the code for a session, so the user is
// authenticated at this point. We just call updateUser({ password }) to set the new password.
// Do not add an auth guard here — the session may take a moment to propagate to the client.
export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setLoading(true);
    setError('');

    const supabase = createClient();
    const { error: sbError } = await supabase.auth.updateUser({ password });

    if (sbError) {
      setError(sbError.message);
      setLoading(false);
    } else {
      setDone(true);
      setTimeout(() => { window.location.href = '/'; }, 2000);
    }
  }

  const inputClass =
    'w-full bg-surface border border-border rounded-lg px-4 py-3 text-white placeholder-muted text-sm outline-none focus:border-white/30 transition-colors pr-11';

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

  return (
    <div className="min-h-screen bg-bg flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-3xl font-semibold tracking-tight text-white text-center mb-10">
          Wrapperr
        </h1>

        {done ? (
          <div className="text-center space-y-2">
            <p className="text-white font-medium">Password set.</p>
            <p className="text-muted text-sm">Taking you to the app…</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <p className="text-muted text-sm text-center mb-2">Set a new password for your account.</p>
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="New password"
                required
                className={inputClass}
              />
              <button type="button" onClick={() => setShowPassword((s) => !s)} tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-white transition-colors">
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            <div className="relative">
              <input
                type={showConfirm ? 'text' : 'password'}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Confirm password"
                required
                className={inputClass}
              />
              <button type="button" onClick={() => setShowConfirm((s) => !s)} tabIndex={-1}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-white transition-colors">
                {showConfirm ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
            {error && <p className="text-red-400 text-xs">{error}</p>}
            <button
              type="submit"
              disabled={loading || !password || !confirm}
              className="w-full bg-white text-black font-medium py-3 rounded-lg text-sm transition-opacity disabled:opacity-40 hover:opacity-90"
            >
              {loading ? '…' : 'Set password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
