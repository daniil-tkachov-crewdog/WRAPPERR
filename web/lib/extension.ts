import type { AIModel } from './types';

export function isExtensionActive(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as any).__WRAPPERR_EXTENSION_ACTIVE__ === true;
}

let requestCounter = 0;

export function sendMessageToAI(ai: AIModel, message: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const requestId = `req_${++requestCounter}_${Date.now()}`;
    const timeout = setTimeout(() => {
      window.removeEventListener('message', handler);
      reject(new Error('Extension response timeout'));
    }, 60000);

    function handler(event: MessageEvent) {
      if (
        event.data?.type === 'WRAPPERR_RESPONSE' &&
        event.data?.requestId === requestId
      ) {
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        if (event.data.error) {
          reject(new Error(event.data.error));
        } else {
          resolve(event.data.response as string);
        }
      }
    }

    window.addEventListener('message', handler);
    window.postMessage({ type: 'WRAPPERR_SEND', requestId, ai, message }, '*');
  });
}
