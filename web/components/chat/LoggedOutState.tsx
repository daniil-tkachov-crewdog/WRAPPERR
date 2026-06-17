import Link from 'next/link';

// LoggedOutState — full-pane prompt shown in the chat area when there is no Supabase session
// (user === null). It is the auth gate's "front door": a logged-out visitor lands here instead
// of the live chat, so no message can be sent and no Supabase/AI feature can fire. The centered
// copy asks the user to log in; the button routes to the existing /login page.
// Pairs with the grayed-out composer mock rendered just below it in ChatWindow — together they
// satisfy "centered login message + disabled chatbar". Keep this purely presentational: all auth
// state lives in page.tsx and is passed down as `user`.
export default function LoggedOutState() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6 text-center">
      <div className="w-full max-w-sm space-y-5">
        {/* Login CTA copy. Sits dead-centre of the pane so it's the first thing a logged-out
            user sees. */}
        <div>
          <h2 style={{ fontSize: 22, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
            Log in to start chatting
          </h2>
          <p style={{ color: 'var(--dim)', fontSize: 13.5, lineHeight: 1.5 }}>
            You need to be logged in to use the chat and any AI feature.
          </p>
        </div>

        {/* Log In button → existing /login page. White-on-black treatment mirrors the
            NoExtensionState CTA so the disabled-state screens feel like one family. */}
        <Link
          href="/login"
          className="inline-flex items-center gap-2 font-medium rounded-lg text-sm hover:opacity-90 transition-opacity"
          style={{ background: '#fff', color: '#000', padding: '10px 20px' }}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
            <path d="M10 17l5-5-5-5" />
            <path d="M15 12H3" />
          </svg>
          Log In
        </Link>
      </div>
    </div>
  );
}
