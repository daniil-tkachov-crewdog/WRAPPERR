// DEFAULT_PROMPT: fallback text used when the user hasn't customised the summary prompt yet
// or after Reset. Keep this string in sync with SUMMARY_PROMPT in web/lib/constants.ts —
// the web app uses its own copy when relaying context between AIs; this popup is purely for
// the user to see/edit what's persisted in chrome.storage.sync (the web app does NOT read it).
const DEFAULT_PROMPT = `Summarise this conversation for transfer to another AI so it can continue without loss of context.

Include:
- User goal
- Key context (facts, constraints, tools, names)
- What has been done and current state
- User preferences (tone, format, rules)
- Next step

Rules:
- Do not answer the task
- No filler or explanations
- Keep it concise and accurate

Output format:

CONTEXT SUMMARY
User goal:
Key context:
Progress:
Preferences:
Next step:`;

// DOM handles — cached at script start. Popup is a one-shot view so we don't need to re-query.
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const summaryPrompt = document.getElementById('summaryPrompt');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const savedMsg = document.getElementById('savedMsg');

// Initial prompt load: chrome.storage.sync persists across devices when the user is signed
// into Chrome. Falls back to DEFAULT_PROMPT on first run.
chrome.storage.sync.get(['summaryPrompt'], (result) => {
  summaryPrompt.value = result.summaryPrompt ?? DEFAULT_PROMPT;
});

// checkStatus: drives the colored status dot. Three states:
//   - "Setting up"     : the Wrapperr web app isn't open in any tab — nothing to talk to.
//   - "There's an issue": the SW didn't answer or reported not-connected.
//   - "Connected"      : SW replied with status: 'connected'.
// We sniff for the web app by host substring (onrender.com / localhost:3000); update both if
// the production host changes. Wrapped in try/catch so any tabs/runtime API throw lands on
// the "issue" state rather than leaving the dot frozen on "Checking…".
async function checkStatus() {
  try {
    const tabs = await chrome.tabs.query({});
    const wrapperrTab = tabs.find(
      (t) => t.url?.includes('onrender.com') || t.url?.includes('localhost:3000')
    );

    if (!wrapperrTab) {
      setStatus('setting-up', 'Setting up');
      return;
    }

    chrome.runtime.sendMessage({ type: 'WRAPPERR_GET_STATUS' }, (res) => {
      if (chrome.runtime.lastError || !res || res.status !== 'connected') {
        setStatus('issue', 'There\'s an issue');
      } else {
        setStatus('connected', 'Connected');
      }
    });
  } catch {
    setStatus('issue', 'There\'s an issue');
  }
}

function setStatus(state, text) {
  statusDot.className = 'dot ' + state;
  statusText.textContent = text;
}

checkStatus();

// Save/Reset wiring. Both write to chrome.storage.sync and show a transient "Saved!" /
// "Reset to default." message that clears after 2s. Reset also locally repopulates the textarea
// so the change is visible immediately without re-opening the popup.
saveBtn.addEventListener('click', () => {
  chrome.storage.sync.set({ summaryPrompt: summaryPrompt.value }, () => {
    savedMsg.textContent = 'Saved!';
    setTimeout(() => (savedMsg.textContent = ''), 2000);
  });
});

resetBtn.addEventListener('click', () => {
  summaryPrompt.value = DEFAULT_PROMPT;
  chrome.storage.sync.set({ summaryPrompt: DEFAULT_PROMPT });
  savedMsg.textContent = 'Reset to default.';
  setTimeout(() => (savedMsg.textContent = ''), 2000);
});
