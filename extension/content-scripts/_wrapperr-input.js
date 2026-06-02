// User-input injection. Centralised so:
//   1. Each AI's content script declares only WHICH element to type into; HOW to type is here.
//   2. Future input kinds (voice transcription, file attachments) get a single implementation
//      that every AI inherits.
//   3. If injection breaks for one AI, the fix lives in exactly one place — nothing else moves.
//
// Strategy auto-selection by element type:
//   <textarea>/<input>  → native-field (React prototype setter + input event)
//   anything else       → contenteditable (execCommand insertHTML with paragraph-wrapped lines)
//
// Why insertHTML for contenteditable instead of synthetic ClipboardEvent paste:
// Synthetic ClipboardEvent('paste', {clipboardData}) dispatched from an extension's isolated
// world has a known cross-world limitation — the DataTransfer object isn't visible to the page's
// MAIN-world paste listeners (Quill, ProseMirror, etc.), so editors see an empty paste and
// nothing is inserted. execCommand('insertHTML') is a synchronous DOM operation: it inserts
// nodes directly into the contenteditable, and every modern rich-text editor's mutation
// observer picks them up and rebuilds its internal model. Cross-world safe, multi-line safe,
// works with numbered lists / code fences / any prose the user types.
//
// API:
//   await wrapperrInjectInput(targetEl, payload, options)
//     payload: { kind: 'text', text: '...' }
//              future:  { kind: 'voice', audio: Blob }
//              future:  { kind: 'file',  files: File[], caption?: string }
//     options: { strategy?: 'native-field' | 'contenteditable' | 'contenteditable-text' }
//              omit strategy for auto-select. 'contenteditable-text' is the Lexical-friendly
//              variant (beforeinput events instead of insertHTML) — see injectViaContentEditableText
//              for why ProseMirror/Tiptap stay on the default but Lexical needs the override.
async function wrapperrInjectInput(targetEl, payload, options) {
  if (!targetEl) throw new Error('wrapperrInjectInput: no target element');
  if (!payload || payload.kind !== 'text') {
    throw new Error('wrapperrInjectInput: only kind="text" is supported (voice/file are placeholders)');
  }
  const opts = options || {};
  const isNativeField = targetEl.tagName === 'TEXTAREA' || targetEl.tagName === 'INPUT';
  const strategy = opts.strategy || (isNativeField ? 'native-field' : 'contenteditable');

  targetEl.focus();

  if (strategy === 'native-field') {
    await injectViaNativeField(targetEl, payload.text);
  } else if (strategy === 'contenteditable') {
    await injectViaContentEditable(targetEl, payload.text);
  } else if (strategy === 'contenteditable-text') {
    await injectViaContentEditableText(targetEl, payload.text);
  } else {
    throw new Error('wrapperrInjectInput: unknown strategy ' + strategy);
  }
}

// React-controlled <textarea>/<input>: assign via the prototype setter so React's internal
// tracked-value diff sees the change and fires onChange. Plain el.value = ... is silently
// ignored by React-controlled inputs.
async function injectViaNativeField(el, text) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, text); else el.value = text;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// HTML-escape so user-provided text can't break the inserted markup or run script.
function escapeHtmlForInsert(s) {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;'  :
    c === '>' ? '&gt;'  :
    c === '"' ? '&quot;' :
                '&#39;'
  ));
}

// Contenteditable insertion. Walks the message line by line, wraps each line in <p>, and uses
// execCommand('insertHTML') to replace the current selection (which we expand to cover the
// whole editor first so we overwrite any existing content). Blank lines become <p><br></p> so
// the editor preserves the paragraph break instead of collapsing it.
async function injectViaContentEditable(el, text) {
  const sel = window.getSelection();
  if (sel) {
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  const html = text.split('\n').map((line) => (
    line ? '<p>' + escapeHtmlForInsert(line) + '</p>' : '<p><br></p>'
  )).join('');

  document.execCommand('insertHTML', false, html);

  // Some editors (Quill, ProseMirror) reconcile DOM changes inside a microtask via mutation
  // observers; give them a tick before the caller checks send-button state.
  await new Promise((r) => setTimeout(r, 300));
}

// Contenteditable insertion for Lexical (Meta's editor framework; used by Perplexity).
// Lexical does NOT register text written by execCommand('insertText'/'insertHTML') — those
// land as raw DOM characters its editorState never sees, so the text shows but the Submit
// button stays disabled. The reliable path is to dispatch the same `beforeinput` events a real
// keystroke produces; Lexical's onBeforeInput reads event.data and updates its own state,
// which enables Submit. See the body for the per-line insertText / insertParagraph sequence.
async function injectViaContentEditableText(el, text) {
  // Wake Lexical's editor selection with a synthetic pointer interaction, then focus. Lexical
  // only initialises its internal cursor on a real click — focus() alone leaves that selection
  // null and any input is ignored.
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  el.focus();

  // Select any existing content so the first insertText overwrites it (matters when an earlier
  // failed attempt left a stray newline behind).
  document.execCommand('selectAll', false, null);

  // Feed the text through Lexical via `beforeinput` insertText events — the exact path a real
  // keystroke takes. Lexical's onBeforeInput reads event.data and writes it into its OWN
  // editorState, which is what flips the Submit button to enabled. The previous
  // execCommand('insertText') only wrote raw DOM characters that Lexical never registered, so
  // the text showed but Send stayed disabled (the dead-button bug). Paragraph breaks go through
  // the matching insertParagraph inputType, same as pressing Enter.
  const fire = (inputType, data) => el.dispatchEvent(new InputEvent('beforeinput', {
    inputType, data, bubbles: true, cancelable: true,
  }));

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) fire('insertParagraph', null);
    if (lines[i]) fire('insertText', lines[i]);
  }

  // Lexical reconciles via mutation observer; give it a tick so the send button finishes
  // enabling before the caller clicks it.
  await new Promise((r) => setTimeout(r, 300));
}
