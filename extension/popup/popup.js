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

const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');
const summaryPrompt = document.getElementById('summaryPrompt');
const saveBtn = document.getElementById('saveBtn');
const resetBtn = document.getElementById('resetBtn');
const savedMsg = document.getElementById('savedMsg');

// Load saved prompt
chrome.storage.sync.get(['summaryPrompt'], (result) => {
  summaryPrompt.value = result.summaryPrompt ?? DEFAULT_PROMPT;
});

// Check connection status by querying Wrapperr tabs
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
      if (chrome.runtime.lastError || !res) {
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
