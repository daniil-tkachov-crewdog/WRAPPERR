import TutorialPopup from './TutorialPopup';

// NotLoggedInState — full-pane fallback shown when there's no Supabase session. Currently a
// thin shell around TutorialPopup; the auth-gate path is dormant (ChatWindow no longer routes
// here), but the file is kept so flipping the gate back on doesn't require new wiring.
export default function NotLoggedInState() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <TutorialPopup />
    </div>
  );
}
