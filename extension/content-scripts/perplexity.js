// Idempotency guard: chrome.scripting.executeScript re-runs this file every time the SW's
// injectContentScript is called. Perplexity navigates between queries (the URL changes from
// /perplexity to /search/<uuid>), which triggers more re-injections than Grok/Gemini ever see
// — and a top-level `const RESPONSE_SELECTOR` throws "already declared" on every re-run,
// halting the re-execution before any new handler can install. Wrapping the file in a guard
// makes re-injection a silent no-op: the first run installs everything, later runs return early.
if (!window.__wrapperrPerplexityInited) {
  window.__wrapperrPerplexityInited = true;

  // injectMessage: type the message into Perplexity's Lexical composer and press Send.
  //
  // Composer is Lexical (Meta's editor framework). Lexical is stubborn about programmatic input
  // — different builds accept different injection techniques, and one that works today can stop
  // working after a Perplexity update. So instead of betting on ONE method, we run a CASCADE:
  // try a method, check whether it actually worked, and if not, clear the box and fall through
  // to the next. The reliable success signal is the Submit button becoming active — Perplexity
  // only shows/enables it once Lexical has registered real text in its OWN editorState (raw DOM
  // text alone leaves Send dead). Whichever method flips Send on wins at runtime. Every method
  // lives here so the whole mechanism stays inside the Perplexity file.
  async function injectMessage(message) {
    const findInput = () => document.querySelector('#ask-input')
      ?? document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]')
      ?? document.querySelector('div[contenteditable="true"][role="textbox"]');
    let input = findInput();
    if (!input) throw new Error('Perplexity input not found');

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // Submit button: aria-label="Submit", type="button". When the box is empty Perplexity shows
    // a voice button instead, so the Submit button existing AND enabled is itself the proof that
    // Lexical accepted our text.
    const getSendBtn = () => document.querySelector('button[aria-label="Submit"][type="button"]')
      ?? document.querySelector('button[aria-label="Submit"]');
    const sendReady = () => {
      const b = getSendBtn();
      return (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') ? b : null;
    };

    // wake: a synthetic click initialises Lexical's internal cursor (focus() alone leaves its
    // selection null and all input is ignored), then focus.
    const wake = (el) => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      el.focus();
    };
    const fireBeforeInput = (el, inputType, data) => el.dispatchEvent(
      new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }));

    // clearInput: wipe whatever a previous failed method left behind before trying the next.
    const clearInput = (el) => {
      wake(el);
      document.execCommand('selectAll', false, null);
      document.execCommand('delete');
    };

    // ---- Injection methods, tried in cascade order ----

    // Method 1: beforeinput events — the path a real keystroke takes; Lexical reads event.data
    // into its editorState.
    const mBeforeInput = (el) => {
      wake(el); document.execCommand('selectAll', false, null);
      const lines = message.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) fireBeforeInput(el, 'insertParagraph', null);
        if (lines[i]) fireBeforeInput(el, 'insertText', lines[i]);
      }
    };

    // Method 2: execCommand insertText — synchronous DOM insert that some Lexical builds pick up
    // through their input listener.
    const mExecCommand = (el) => {
      wake(el); document.execCommand('selectAll', false, null);
      const lines = message.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) document.execCommand('insertParagraph');
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
      }
    };

    // Method 3: synthetic paste — Lexical has a dedicated paste handler that reads clipboardData
    // and inserts into its state.
    const mPaste = (el) => {
      wake(el); document.execCommand('selectAll', false, null);
      const dt = new DataTransfer();
      dt.setData('text/plain', message);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    };

    // Method 4: per-character keystroke simulation — slowest but closest to a human; some
    // editors only commit on a full keydown / beforeinput / input / keyup cycle per character.
    const mPerChar = (el) => {
      wake(el); document.execCommand('selectAll', false, null);
      for (const ch of message) {
        if (ch === '\n') { fireBeforeInput(el, 'insertParagraph', null); continue; }
        el.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
        fireBeforeInput(el, 'insertText', ch);
        el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: ch, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
      }
    };

    // Method 5: raw textContent + input event — last-ditch; writes the DOM directly and nudges
    // any generic input listener.
    const mTextContent = (el) => {
      wake(el);
      el.textContent = message;
      el.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: message, bubbles: true }));
    };

    const methods = [mBeforeInput, mExecCommand, mPaste, mPerChar, mTextContent];

    for (const method of methods) {
      input = findInput() || input;
      clearInput(input);
      await wait(60);
      try { method(input); } catch (_) { /* method threw — fall through to the next */ }

      // Give Lexical up to ~1.5 s to register the text and enable Submit. If it does, the method
      // worked: click Send and we're done.
      for (let i = 0; i < 15; i++) {
        const btn = sendReady();
        if (btn) { btn.click(); return; }
        await wait(100);
      }
    }

    throw new Error('Perplexity: no injection method enabled Send');
  }

  // perplexityAnswerEl: locate the latest rendered answer container.
  //
  // Perplexity wraps each answer's prose in a Tailwind `prose` block; the LAST one on the
  // page is the newest answer. We anchor on the `prose` class (very stable on Perplexity)
  // and fall back to other answer-ish containers if the markup ever shifts. Important: this
  // is structural, NOT dependent on Perplexity's private SSE stream — which is exactly why
  // capturing the answer this way can't silently break when they change their stream format.
  function perplexityAnswerEl() {
    const prose = document.querySelectorAll('[class*="prose"]');
    if (prose.length) return prose[prose.length - 1];
    const alt = document.querySelectorAll('[class*="answer"], [class*="markdown"], .markdown');
    return alt.length ? alt[alt.length - 1] : null;
  }

  // perplexityHtmlToMarkdown: convert a rendered answer element into Markdown by walking the
  // DOM. Keyed on HTML tags (h1..h6, ul/ol, pre, table, a, strong...), which are semantically
  // stable across Perplexity redesigns — unlike class names or the SSE shape we relied on
  // before. This is the root fix: the page always holds the full answer the user can see, so
  // the old "parser returned empty → only the trailing code block showed" failure is gone.
  function perplexityHtmlToMarkdown(root) {
    if (!root) return '';

    // Inline pass: text + inline marks (bold/italic/strike/code/links/line-breaks). Returns a
    // single inline string with no block breaks. Used for headings, paragraphs, list items,
    // table cells. Whitespace in text nodes is collapsed the way the browser renders it.
    function inline(node) {
      let out = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.textContent.replace(/\s+/g, ' '); continue; }
        if (child.nodeType !== 1) continue;
        const t = child.tagName.toLowerCase();
        if (t === 'br') { out += '  \n'; continue; }
        if (t === 'strong' || t === 'b') { out += '**' + inline(child).trim() + '**'; continue; }
        if (t === 'em' || t === 'i') { out += '*' + inline(child).trim() + '*'; continue; }
        if (t === 'del' || t === 's') { out += '~~' + inline(child).trim() + '~~'; continue; }
        if (t === 'code') { out += '`' + child.textContent + '`'; continue; }
        if (t === 'a') {
          const href = child.getAttribute('href') || '';
          const label = inline(child).trim();
          out += href ? `[${label}](${href})` : label;
          continue;
        }
        out += inline(child); // unknown inline wrapper — recurse so its text survives
      }
      return out;
    }

    // List pass: bullet/numbered lists with nesting. Pulls nested ul/ol out of each <li> so the
    // item's own text and its sub-list render on separate, correctly-indented lines.
    function list(node, ordered, depth) {
      let out = '';
      let n = 1;
      const pad = '  '.repeat(depth);
      for (const li of node.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        const marker = ordered ? (n++ + '. ') : '- ';
        const own = document.createElement('div');
        const nested = [];
        for (const c of li.childNodes) {
          if (c.nodeType === 1 && /^(ul|ol)$/.test(c.tagName.toLowerCase())) nested.push(c);
          else own.appendChild(c.cloneNode(true));
        }
        out += pad + marker + inline(own).trim() + '\n';
        for (const sub of nested) out += list(sub, sub.tagName.toLowerCase() === 'ol', depth + 1);
      }
      return out;
    }

    // Table pass: GFM pipe table. First row is treated as the header. Pipes in cell text are
    // escaped so they don't break the table syntax.
    function table(node) {
      const rows = [...node.querySelectorAll('tr')];
      if (!rows.length) return '';
      const cells = (tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, '\\|'));
      const head = cells(rows[0]);
      let out = '| ' + head.join(' | ') + ' |\n| ' + head.map(() => '---').join(' | ') + ' |\n';
      for (let r = 1; r < rows.length; r++) out += '| ' + cells(rows[r]).join(' | ') + ' |\n';
      return out;
    }

    // Block pass: emits block-level Markdown (headings, paragraphs, lists, fenced code,
    // blockquotes, tables, rules) with blank-line separation. Unknown containers (div/section
    // wrappers Perplexity nests heavily) are recursed into so we always reach the real content.
    function block(node) {
      let out = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { const s = child.textContent.replace(/\s+/g, ' '); if (s.trim()) out += s; continue; }
        if (child.nodeType !== 1) continue;
        const t = child.tagName.toLowerCase();
        if (/^h[1-6]$/.test(t)) {
          out += '\n' + '#'.repeat(Number(t[1])) + ' ' + inline(child).trim() + '\n\n';
        } else if (t === 'p') {
          out += inline(child).trim() + '\n\n';
        } else if (t === 'ul' || t === 'ol') {
          out += list(child, t === 'ol', 0) + '\n';
        } else if (t === 'pre') {
          // Fenced code block. Language comes from `code class="language-xxx"` when present.
          const codeEl = child.querySelector('code') || child;
          const lang = ((codeEl.getAttribute('class') || '').match(/language-([\w+-]+)/) || [, ''])[1];
          out += '```' + lang + '\n' + codeEl.textContent.replace(/\n$/, '') + '\n```\n\n';
        } else if (t === 'blockquote') {
          out += block(child).trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
        } else if (t === 'table') {
          out += table(child) + '\n';
        } else if (t === 'hr') {
          out += '---\n\n';
        } else if (/^(code|a|strong|b|em|i|del|s|br|span)$/.test(t)) {
          out += inline({ childNodes: [child] }); // stray inline element among blocks
        } else {
          out += block(child); // generic wrapper — descend to find the real blocks
        }
      }
      return out;
    }

    // Collapse runs of 3+ newlines the passes can produce at block boundaries.
    return block(root).replace(/\n{3,}/g, '\n\n').trim();
  }

  // getBaseline: record the newest answer (as Markdown) BEFORE we submit. The SW compares
  // each poll against this text and ignores it while unchanged, so we never mistake the
  // previous answer for our new one. Count is kept for the SW's baselineCount param.
  function getBaseline() {
    const prose = document.querySelectorAll('[class*="prose"]');
    const last = perplexityAnswerEl();
    return { count: prose.length, text: last ? perplexityHtmlToMarkdown(last) : '' };
  }

  // getCurrentState: read the answer straight from the rendered page and convert to Markdown.
  // The DOM always holds the full answer (it is literally what the user sees), so this never
  // returns the empty result the old SSE parser did. The SW's existing stability poll (wait
  // until the text stops changing) handles the streaming/progressive-render case.
  function getCurrentState() {
    const el = perplexityAnswerEl();
    return el ? perplexityHtmlToMarkdown(el) : '';
  }

  // Message listener — guarded against double-installation if the script is re-injected.
  // Same shape as gemini.js / grok.js: WRAPPERR_INJECT_ONLY captures baseline + injects,
  // WRAPPERR_GET_STATE returns the current best response text for the SW's stability poller.
  if (!window.__wrapperrAIListenerOn) {
    window.__wrapperrAIListenerOn = true;
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'WRAPPERR_INJECT_ONLY') {
        (async () => {
          try {
            const baseline = getBaseline();
            await injectMessage(msg.message);
            sendResponse({ ok: true, baseline });
          } catch (err) {
            sendResponse({ ok: false, error: err.message });
          }
        })();
        return true;
      }
      if (msg.type === 'WRAPPERR_GET_STATE') {
        try { sendResponse({ text: getCurrentState() }); }
        catch (err) { sendResponse({ text: '', error: err.message }); }
        return false;
      }
    });
  }
}
