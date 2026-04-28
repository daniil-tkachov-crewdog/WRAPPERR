// Relay postMessage from web app → extension background
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'WRAPPERR_SEND') return;
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
