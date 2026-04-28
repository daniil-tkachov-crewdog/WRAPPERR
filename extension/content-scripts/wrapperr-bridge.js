// Signals to the web app that the extension is active
window.__WRAPPERR_EXTENSION_ACTIVE__ = true;

// Relay postMessage from web app → extension background
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data?.type !== 'WRAPPERR_SEND') return;
  chrome.runtime.sendMessage(event.data);
});

// Relay extension background responses → web app via postMessage
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'WRAPPERR_RESPONSE') {
    window.postMessage(msg, window.location.origin);
  }
});
