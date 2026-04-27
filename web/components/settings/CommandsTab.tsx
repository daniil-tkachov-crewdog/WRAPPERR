export default function CommandsTab() {
  return (
    <div className="space-y-6 max-w-md">
      <h2 className="text-base font-semibold text-white">Commands</h2>

      <div className="inline-flex items-center gap-2 bg-purple-600/15 border border-purple-500/30 rounded-lg px-3 py-1.5">
        <span className="text-purple-400 text-xs font-medium">Coming soon!</span>
      </div>

      <div className="flex items-center justify-center py-12">
        <button
          disabled
          className="flex items-center gap-2 text-sm text-muted border border-border rounded-lg px-4 py-2.5 cursor-not-allowed opacity-40"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
          Add a command
        </button>
      </div>
    </div>
  );
}
