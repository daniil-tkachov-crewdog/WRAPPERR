// User-input injection. Centralised so:
//   1. Each AI's content script declares only WHICH element to type into; HOW to type is here.
//   2. Future input kinds (voice transcription, file attachments) get a single implementation
//      that every AI inherits.
//   3. If injection breaks for one AI, the fix lives in exactly one place — nothing else moves.
//
// Strategy auto-selection: a TEXTAREA / INPUT element uses the React-prototype-setter route so
// React state updates correctly. Anything else (contenteditable, Quill .ql-editor, ProseMirror,
// Lexical, Slate, draft.js) uses a synthetic ClipboardEvent. Every modern rich-text editor on
// the web has a first-class paste handler designed to receive arbitrary multi-line text from
// outside its own keyboard input — that handler walks the payload and builds correct internal
// structure. By delegating to it we never have to track selection state or special-case
// numbered lists / nested blocks / code fences / anything else.
//
// API:
//   await wrapperrInjectInput(targetEl, payload, options)
//     payload: { kind: 'text', text: '...' }
//              future:  { kind: 'voice', audio: Blob }
//              future:  { kind: 'file',  files: File[], caption?: string }
//     options: { strategy?: 'paste' | 'native-textarea' }   // omit for auto-select
async function wrapperrInjectInput(targetEl, payload, options) {
  if (!targetEl) throw new Error('wrapperrInjectInput: no target element');
  if (!payload || payload.kind !== 'text') {
    throw new Error('wrapperrInjectInput: only kind="text" is supported (voice/file are placeholders)');
  }
  const opts = options || {};
  const isNativeField = targetEl.tagName === 'TEXTAREA' || targetEl.tagName === 'INPUT';
  const strategy = opts.strategy || (isNativeField ? 'native-textarea' : 'paste');

  targetEl.focus();

  if (strategy === 'native-textarea') {
    await injectViaNativeTextarea(targetEl, payload.text);
  } else if (strategy === 'paste') {
    await injectViaPaste(targetEl, payload.text);
  } else {
    throw new Error('wrapperrInjectInput: unknown strategy ' + strategy);
  }
}

// React-controlled <textarea>/<input>: assign via the prototype setter so React's internal
// tracked-value diff sees the change and fires onChange. Plain el.value = ... is silently
// ignored by React-controlled inputs.
async function injectViaNativeTextarea(el, text) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, text); else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// Synthetic paste — the universal way to deliver multi-line / multi-format content into any
// rich-text editor. Steps:
//   1. Select the entire editor contents and delete, so paste replaces instead of appending.
//   2. Build a DataTransfer with text/plain (every editor accepts this slot).
//   3. Dispatch ClipboardEvent('paste') on the editor. Its paste handler reads clipboardData,
//      walks the text, and produces correct internal structure (paragraphs, lists, code).
//   4. Settle delay so editors that process paste asynchronously have a chance to flush before
//      the caller queries the send button's disabled state.
async function injectViaPaste(el, text) {
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  document.execCommand('delete', false, undefined);

  const dt = new DataTransfer();
  dt.setData('text/plain', text);
  const evt = new ClipboardEvent('paste', {
    clipboardData: dt,
    bubbles: true,
    cancelable: true,
  });
  el.dispatchEvent(evt);

  await new Promise((r) => setTimeout(r, 400));
}
