/**
 * newtab.js — PostMessage Bridge
 *
 * This script is the middleman between the dashboard (running inside the iframe
 * at localhost:3456) and Chrome's tabs API.
 *
 * Why do we need a bridge? Chrome extensions can call chrome.tabs.query(),
 * chrome.tabs.remove(), etc. — but a plain webpage (even one running locally)
 * cannot. The dashboard is a webpage, so it has to ask the extension to do
 * those privileged operations on its behalf. It does this via postMessage, and
 * this script listens for those messages, performs the Chrome API calls, and
 * posts the results back.
 */

// ─── Element references ───────────────────────────────────────────────────────
const frame    = document.getElementById('dashboard-frame');
const fallback = document.getElementById('fallback');

// ─── 1. Check whether the server is reachable ────────────────────────────────
// We use 'no-cors' mode so the fetch doesn't fail due to CORS headers. We don't
// need to read the response — we just need to know *something* answered.
fetch('http://localhost:3456', { mode: 'no-cors' })
  .then(() => {
    // Server is up — keep the iframe visible (it's already loading)
  })
  .catch(() => {
    // Server is down — hide the iframe and reveal the human-readable fallback
    showFallback();
  });

// ─── 2. Iframe load-error handler ────────────────────────────────────────────
// This catches cases where the fetch succeeded but the iframe itself errors
// (e.g. the server starts then immediately crashes).
frame.addEventListener('error', showFallback);

function showFallback() {
  frame.classList.add('hidden');
  fallback.classList.remove('hidden');
}

// ─── 3. PostMessage listener ─────────────────────────────────────────────────
// The dashboard posts a message like:
//   { messageId: 'abc123', action: 'getTabs', payload: { ... } }
// We handle the action, then reply with the same messageId so the dashboard
// can match the response to the original request.
window.addEventListener('message', async (event) => {
  // Security: only accept messages from our dashboard origin
  if (event.origin !== 'http://localhost:3456') return;

  const msg = event.data || {};
  const { messageId, action } = msg;
  if (!messageId || !action) return; // Ignore malformed messages

  let response;

  try {
    if (action === 'getTabs') {
      response = await handleGetTabs();

    } else if (action === 'closeTabs') {
      // Dashboard sends urls flat: { action, messageId, urls: [...] }
      response = await handleCloseTabs({ urls: msg.urls });

    } else if (action === 'focusTabs') {
      // Dashboard sends urls as an array; we focus the first match
      response = await handleFocusTabs({ urls: msg.urls });

    } else {
      response = { error: `Unknown action: ${action}` };
    }
  } catch (err) {
    response = { error: err.message };
  }

  // Always include success flag — the dashboard checks for it
  if (!response.error) {
    response.success = true;
  }

  // Send the response back to the dashboard inside the iframe
  frame.contentWindow.postMessage(
    { messageId, ...response },
    'http://localhost:3456'
  );
});

// ─── Action handlers ─────────────────────────────────────────────────────────

/**
 * getTabs — Returns a trimmed list of all open Chrome tabs.
 * We only send the fields the dashboard actually needs; the full Tab object
 * from Chrome has many noisy fields we don't want to expose.
 */
async function handleGetTabs() {
  const tabs = await chrome.tabs.query({});
  const simpleTabs = tabs.map(tab => ({
    id:       tab.id,
    url:      tab.url,
    title:    tab.title,
    windowId: tab.windowId,
    active:   tab.active,
  }));
  return { tabs: simpleTabs };
}

/**
 * closeTabs — Closes all tabs whose hostname matches any of the given URLs.
 *
 * Why match by hostname rather than exact URL? If the user wants to close
 * "twitter.com" tabs, we should close all of them regardless of which tweet
 * they're on. Matching by hostname (e.g. "twitter.com") is more intuitive
 * than requiring an exact URL match.
 *
 * @param {Object} payload - { urls: string[] }  — list of URLs to match
 */
async function handleCloseTabs({ urls = [] } = {}) {
  // Extract just the hostname from each URL we want to match against
  const targetHostnames = urls.map(u => {
    try { return new URL(u).hostname; }
    catch { return null; }
  }).filter(Boolean);

  const allTabs = await chrome.tabs.query({});

  // Find tabs whose hostname matches any of the targets
  const matchingTabIds = allTabs
    .filter(tab => {
      try {
        const tabHostname = new URL(tab.url).hostname;
        return targetHostnames.includes(tabHostname);
      } catch {
        return false; // Skip tabs with non-parseable URLs (e.g. chrome:// pages)
      }
    })
    .map(tab => tab.id);

  if (matchingTabIds.length > 0) {
    await chrome.tabs.remove(matchingTabIds);
  }

  return { closedCount: matchingTabIds.length };
}

/**
 * focusTabs — Switches Chrome's view to the first tab matching the given URL.
 *
 * "Focusing" means: make that tab the active tab in its window, and bring
 * that window to the front.
 *
 * @param {Object} payload - { url: string }
 */
async function handleFocusTabs({ urls = [] } = {}) {
  if (!urls || urls.length === 0) return { error: 'No URLs provided' };

  // Extract hostnames from all URLs we want to match
  const targetHostnames = urls.map(u => {
    try { return new URL(u).hostname; }
    catch { return null; }
  }).filter(Boolean);

  if (targetHostnames.length === 0) return { error: 'No valid URLs' };

  const allTabs = await chrome.tabs.query({});

  // Find the first tab whose hostname matches any target
  const matchingTab = allTabs.find(tab => {
    try { return targetHostnames.includes(new URL(tab.url).hostname); }
    catch { return false; }
  });

  if (!matchingTab) {
    return { error: 'No matching tab found' };
  }

  // Make the tab active within its window
  await chrome.tabs.update(matchingTab.id, { active: true });

  // Bring the window itself into focus (puts it on top of other windows)
  await chrome.windows.update(matchingTab.windowId, { focused: true });

  return { focusedTabId: matchingTab.id };
}
