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
  // Composer is Lexical (Meta's editor framework). Hard-won recipe from live testing:
  //   • execCommand('insertText') ALONE does not work — Lexical ignores it and Send stays dead.
  //   • A synthetic `beforeinput` insertText event PRIMES Lexical (sets up its selection/intent)
  //     but on its own also leaves Send dead.
  //   • Doing the beforeinput PRIME and THEN the execCommand COMMIT is what actually registers
  //     the text in Lexical's editorState and enables the Submit button.
  // The naive prime+commit leaves the text twice (the prime copy + the commit copy), so after
  // Send lights up — i.e. once Lexical is reliably registering execCommand edits — we select all
  // and re-insert the message ONCE to leave a single clean copy. Then click Send.
  async function injectMessage(message) {
    const findInput = () => document.querySelector('#ask-input')
      ?? document.querySelector('div[contenteditable="true"][data-lexical-editor="true"]')
      ?? document.querySelector('div[contenteditable="true"][role="textbox"]');
    let input = findInput();
    if (!input) throw new Error('Perplexity input not found');

    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const lines = message.split('\n');

    const getSendBtn = () => document.querySelector('button[aria-label="Submit"][type="button"]')
      ?? document.querySelector('button[aria-label="Submit"]');
    const sendReady = () => {
      const b = getSendBtn();
      return (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') ? b : null;
    };

    // wake: synthetic click initialises Lexical's internal cursor (focus() alone leaves it null).
    const wake = (el) => {
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      el.focus();
    };
    const fireBeforeInput = (el, inputType, data) => el.dispatchEvent(
      new InputEvent('beforeinput', { inputType, data, bubbles: true, cancelable: true }));

    // prime: beforeinput pass that wakes up Lexical's text pipeline.
    const prime = (el) => {
      wake(el); document.execCommand('selectAll', false, null);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) fireBeforeInput(el, 'insertParagraph', null);
        if (lines[i]) fireBeforeInput(el, 'insertText', lines[i]);
      }
    };
    // commit: execCommand pass that actually registers text in Lexical's state (enables Submit).
    const commit = (el) => {
      wake(el); document.execCommand('selectAll', false, null);
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) document.execCommand('insertParagraph');
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
      }
    };

    for (let attempt = 0; attempt < 4; attempt++) {
      input = findInput() || input;
      // Start clean: select-all + delete clears Lexical-registered text; textContent wipe clears
      // any stray raw text a previous attempt left that Lexical's selectAll won't cover.
      wake(input);
      document.execCommand('selectAll', false, null);
      document.execCommand('delete');
      if ((input.innerText || '').replace(/\s+/g, '').length) input.textContent = '';

      prime(input);
      commit(input);

      // Wait for Send to enable — proof the prime+commit registered the text.
      let ready = false;
      for (let i = 0; i < 15; i++) { if (sendReady()) { ready = true; break; } await wait(100); }
      if (!ready) continue; // retry the whole prime+commit

      // Lexical is now registering execCommand edits, so a clean select-all + re-insert leaves a
      // SINGLE copy (removing the prime+commit duplication) without disabling Send.
      wake(input);
      document.execCommand('selectAll', false, null);
      document.execCommand('delete');
      for (let i = 0; i < lines.length; i++) {
        if (i > 0) document.execCommand('insertParagraph');
        if (lines[i]) document.execCommand('insertText', false, lines[i]);
      }

      // Click Send once it's enabled with the single clean copy.
      for (let i = 0; i < 15; i++) { const b = sendReady(); if (b) { b.click(); return; } await wait(100); }
      const b = getSendBtn(); if (b) { b.click(); return; }
    }

    throw new Error('Perplexity: Send never enabled after injecting');
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

  // katexLatex: recover the ORIGINAL LaTeX from a KaTeX-rendered element. KaTeX embeds the
  // source TeX in <annotation encoding="application/x-tex"> inside its MathML; reading that is
  // far more reliable than trying to reverse the rendered span soup. Returns '' if not found.
  function katexLatex(el) {
    const ann = el.querySelector('annotation[encoding="application/x-tex"]');
    return ann ? ann.textContent.trim() : '';
  }

  // perplexityHtmlToMarkdown: convert a rendered answer element into Markdown by walking the
  // DOM. Keyed on HTML tags (h1..h6, ul/ol, pre, table, a, img, katex...), which are
  // semantically stable across Perplexity redesigns — unlike class names or the SSE shape we
  // relied on before. Goal: capture EVERY style the user sees so nothing is lost in the UI.
  function perplexityHtmlToMarkdown(root) {
    if (!root) return '';

    // Inline pass: text + inline marks (bold/italic/strike/code/links/images/math/line-breaks).
    // Returns a single inline string with no block breaks. Used for headings, paragraphs, list
    // items, table cells. Whitespace in text nodes is collapsed the way the browser renders it.
    function inline(node) {
      let out = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { out += child.textContent.replace(/\s+/g, ' '); continue; }
        if (child.nodeType !== 1) continue;
        // Inline math: emit $tex$ and do NOT recurse into KaTeX's internal render spans.
        if (child.classList && child.classList.contains('katex')) {
          const tex = katexLatex(child);
          if (tex) { out += '$' + tex + '$'; continue; }
        }
        const t = child.tagName.toLowerCase();
        if (t === 'br') { out += '  \n'; continue; }
        if (t === 'strong' || t === 'b') { out += '**' + inline(child).trim() + '**'; continue; }
        if (t === 'em' || t === 'i') { out += '*' + inline(child).trim() + '*'; continue; }
        if (t === 'del' || t === 's') { out += '~~' + inline(child).trim() + '~~'; continue; }
        if (t === 'code') { out += '`' + child.textContent + '`'; continue; }
        if (t === 'img') { out += `![${child.getAttribute('alt') || ''}](${child.getAttribute('src') || ''})`; continue; }
        if (t === 'a') {
          const href = child.getAttribute('href') || '';
          const label = inline(child).trim();
          out += href ? `[${label}](${href})` : label;
          continue;
        }
        out += inline(child); // unknown inline wrapper (incl. sub/sup/citations) — recurse so its text + links survive
      }
      return out;
    }

    // List pass: bullet/numbered lists with nesting + GFM task checkboxes. Pulls nested ul/ol
    // out of each <li> so the item's own text and its sub-list render on separate, correctly
    // indented lines.
    function list(node, ordered, depth) {
      let out = '';
      let n = 1;
      const pad = '  '.repeat(depth);
      for (const li of node.children) {
        if (li.tagName.toLowerCase() !== 'li') continue;
        // Task list: render the checkbox state, don't consume an ordered number for it.
        const cb = li.querySelector(':scope > input[type="checkbox"]') || li.querySelector('input[type="checkbox"]');
        const marker = cb ? (cb.checked ? '- [x] ' : '- [ ] ') : (ordered ? (n++ + '. ') : '- ');
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
    // blockquotes, tables, rules, display math) with blank-line separation. Unknown containers
    // (div/section wrappers Perplexity nests heavily) are recursed into so we always reach the
    // real content.
    function block(node) {
      let out = '';
      for (const child of node.childNodes) {
        if (child.nodeType === 3) { const s = child.textContent.replace(/\s+/g, ' '); if (s.trim()) out += s; continue; }
        if (child.nodeType !== 1) continue;
        // Display / inline math block: $$tex$$ for katex-display, $tex$ otherwise. Checked first
        // so we never recurse into KaTeX's internal spans.
        if (child.classList && (child.classList.contains('katex-display') || child.classList.contains('katex'))) {
          const tex = katexLatex(child);
          if (tex) {
            out += child.classList.contains('katex-display') ? ('$$\n' + tex + '\n$$\n\n') : ('$' + tex + '$');
            continue;
          }
        }
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
        } else if (/^(code|a|strong|b|em|i|del|s|br|span|sub|sup|img)$/.test(t)) {
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

  // getCurrentState: read the answer with MULTIPLE methods and return the richest, so we never
  // lose styling. Method 1 (DOM→Markdown) captures everything the user sees; Method 2 (the
  // network SSE parser, still injected as providers/perplexity-parser.js) gives Perplexity's own
  // canonical Markdown when the stream was captured; Method 3 (plain innerText) is the
  // always-available fallback. We prefer the longest of the two Markdown methods and only fall
  // back to plain text if both are empty. The SW's stability poll handles streaming.
  function getCurrentState({ sentAt } = {}) {
    const el = perplexityAnswerEl();

    let domMd = '';
    if (el) { try { domMd = perplexityHtmlToMarkdown(el); } catch (_) { domMd = ''; } }

    let netMd = '';
    if (typeof readBestPerplexityText === 'function') {
      try { netMd = readBestPerplexityText(sentAt || 0) || ''; } catch (_) { netMd = ''; }
    }

    const rich = [domMd, netMd].filter(Boolean).sort((a, b) => b.length - a.length)[0];
    if (rich) return rich;

    const plain = el ? (el.innerText || '').trim() : '';
    return plain;
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
        try { sendResponse({ text: getCurrentState(msg) }); }
        catch (err) { sendResponse({ text: '', error: err.message }); }
        return false;
      }
    });
  }
}
