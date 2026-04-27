export default function BillingTab() {
  return (
    <div className="space-y-6 max-w-md">
      <h2 className="text-base font-semibold text-white">Billing</h2>

      <div className="inline-flex items-center gap-2 bg-purple-600/15 border border-purple-500/30 rounded-lg px-3 py-1.5">
        <span className="text-purple-400 text-xs font-medium">Coming soon!</span>
      </div>

      <div className="opacity-40 space-y-4">
        <div className="bg-surface border border-border rounded-xl p-5">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-sm font-semibold text-white">Wrapperr Pro</p>
              <p className="text-xs text-muted mt-1">Unlimited chats, priority support, and more.</p>
            </div>
            <div className="text-right shrink-0 ml-4">
              <p className="text-lg font-bold text-white">£5</p>
              <p className="text-xs text-muted">/month</p>
            </div>
          </div>
          <button
            disabled
            className="mt-4 w-full bg-white/10 text-white text-sm py-2 rounded-lg cursor-not-allowed"
          >
            Subscribe
          </button>
        </div>

        <div className="bg-surface border border-border rounded-xl p-5 space-y-3">
          <p className="text-sm font-medium text-white">Payment method</p>
          <input
            disabled
            placeholder="Card number"
            className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-muted cursor-not-allowed"
          />
          <div className="flex gap-3">
            <input
              disabled
              placeholder="MM / YY"
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-muted cursor-not-allowed"
            />
            <input
              disabled
              placeholder="CVC"
              className="w-full bg-bg border border-border rounded-lg px-3 py-2.5 text-sm text-muted cursor-not-allowed"
            />
          </div>
          <button
            disabled
            className="w-full bg-white/10 text-white text-sm py-2 rounded-lg cursor-not-allowed"
          >
            Add card
          </button>
        </div>
      </div>
    </div>
  );
}
