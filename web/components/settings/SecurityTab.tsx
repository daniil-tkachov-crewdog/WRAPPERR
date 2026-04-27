export default function SecurityTab() {
  return (
    <div className="space-y-6 max-w-md">
      <h2 className="text-base font-semibold text-white">Security</h2>

      <div className="inline-flex items-center gap-2 bg-purple-600/15 border border-purple-500/30 rounded-lg px-3 py-1.5">
        <span className="text-purple-400 text-xs font-medium">Coming soon!</span>
      </div>

      <div className="space-y-3">
        <div className="bg-surface border border-border rounded-xl p-4 opacity-40">
          <p className="text-sm font-medium text-white">Multi-factor authentication</p>
          <p className="text-xs text-muted mt-1">Add an extra layer of security to your account.</p>
        </div>

        <div className="bg-surface border border-border rounded-xl p-4 opacity-40">
          <p className="text-sm font-medium text-white">Set a password</p>
          <p className="text-xs text-muted mt-1">Enable password login in addition to magic links.</p>
        </div>
      </div>
    </div>
  );
}
