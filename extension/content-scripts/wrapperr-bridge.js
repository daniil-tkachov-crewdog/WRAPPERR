// Relay postMessage from web app → extension background. Both WRAPPERR_SEND (normal prompt)
// and WRAPPERR_REREAD (re-scrape last response without re-prompting) follow the same envelope:
// type + requestId, with the SW responding via WRAPPERR_RESPONSE keyed by requestId. Any new
// outbound type added in extension.ts must be added here too, or it will be silently dropped.
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const t = event.data?.type;
  if (t !== 'WRAPPERR_SEND' && t !== 'WRAPPERR_REREAD') return;
  chrome.runtime.sendMessage(event.data);
});

// Relay extension background responses → web app via postMessage,
// and respond to liveness pings from the service worker.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'WRAPPERR_RESPONSE') {
    window.postMessage(msg, window.location.origin);
    return;
  }
  if (msg.type === 'WRAPPERR_PING') {
    sendResponse({ pong: true });
  }
});
