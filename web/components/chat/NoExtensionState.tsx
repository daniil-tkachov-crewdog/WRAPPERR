export default function NoExtensionState() {
  return (
    <div className="flex flex-col items-center justify-center h-full px-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="bg-surface border border-border rounded-2xl p-8 text-center space-y-5">
          <div>
            <h2 className="text-lg font-semibold text-white mb-2">
              Set up Wrapperr Extension
            </h2>
            <p className="text-muted text-sm leading-relaxed">
              Install the Chrome extension to start chatting with any AI model.
            </p>
          </div>

          <a
            href="#"
            className="inline-flex items-center gap-2 bg-white text-black font-medium px-5 py-2.5 rounded-lg text-sm hover:opacity-90 transition-opacity"
            onClick={(e) => e.preventDefault()}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 2a10 10 0 1 0 10 10H12V2z"/>
              <path d="M12 2a10 10 0 0 1 10 10"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
            Add to Chrome
          </a>
        </div>

        <div className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
          <span className="text-amber-400 mt-0.5 shrink-0">⚠</span>
          <p className="text-amber-300 text-xs leading-relaxed">
            For the extension to work properly, you should be logged into all your AI accounts in the Chrome browser and use the website in Chrome.
          </p>
        </div>
      </div>
    </div>
  );
}
