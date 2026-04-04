/* ================================================================
   Tab Mission Control — Dashboard App

   This file is the brain of the dashboard. It:
   1. Talks to the Chrome extension (to read/close actual browser tabs)
   2. Fetches mission data from our Express server (/api/missions)
   3. Renders mission cards, banners, stats, and the scatter meter
   4. Handles all user actions (close tabs, archive, dismiss, focus)
   ================================================================ */

'use strict';


/* ----------------------------------------------------------------
   EXTENSION BRIDGE

   The dashboard runs in an iframe inside the Chrome extension's
   new-tab page. To communicate with the extension's background
   script, we use window.postMessage — the extension's content
   script listens and relays messages.

   When running in a regular browser tab (dev mode), we gracefully
   fall back without crashing.
   ---------------------------------------------------------------- */

// Track whether the extension is actually available (set after first successful call)
let extensionAvailable = false;

// Track all open tabs fetched from the extension (array of tab objects)
let openTabs = [];

/**
 * sendToExtension(action, data)
 *
 * Sends a message to the parent frame (the Chrome extension) and
 * waits up to 3 seconds for a response.
 *
 * Think of it like sending a text message and waiting for a reply —
 * if no reply comes in 3 seconds, we give up gracefully.
 */
function sendToExtension(action, data = {}) {
  return new Promise((resolve) => {
    // If we're not inside an iframe, there's no extension to talk to
    if (window.parent === window) {
      resolve({ success: false, reason: 'not-in-extension' });
      return;
    }

    // Generate a random ID so we can match the response to this specific request
    const messageId = 'tmc-' + Math.random().toString(36).slice(2);

    // Set a 3-second timeout in case the extension doesn't respond
    const timer = setTimeout(() => {
      window.removeEventListener('message', handler);
      resolve({ success: false, reason: 'timeout' });
    }, 3000);

    // Listen for the matching response from the extension
    function handler(event) {
      if (event.data && event.data.messageId === messageId) {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        resolve(event.data);
      }
    }

    window.addEventListener('message', handler);

    // Send the message to the parent frame (extension)
    window.parent.postMessage({ action, messageId, ...data }, '*');
  });
}

/**
 * fetchOpenTabs()
 *
 * Asks the extension for the list of currently open browser tabs.
 * Sets extensionAvailable = true if it works, false otherwise.
 */
async function fetchOpenTabs() {
  const result = await sendToExtension('getTabs');
  if (result && result.success && Array.isArray(result.tabs)) {
    openTabs = result.tabs;
    extensionAvailable = true;
  } else {
    openTabs = [];
    extensionAvailable = false;
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Tells the extension to close all tabs matching the given URLs.
 * After closing, we re-fetch the tab list so our state stays accurate.
 */
async function closeTabsByUrls(urls) {
  if (!extensionAvailable || !urls || urls.length === 0) return;
  await sendToExtension('closeTabs', { urls });
  // Refresh our local tab list to reflect what was closed
  await fetchOpenTabs();
}

/**
 * focusTabsByUrls(urls)
 *
 * Tells the extension to bring the first matching tab into focus
 * (switch to that tab in Chrome). Used by the "Focus on this" button.
 */
async function focusTabsByUrls(urls) {
  if (!extensionAvailable || !urls || urls.length === 0) return;
  await sendToExtension('focusTabs', { urls });
}


/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * showToast(message)
 *
 * Shows a brief pop-up notification at the bottom of the screen.
 * Like the little notification that pops up when you send a message.
 */
function showToast(message) {
  const toast = document.getElementById('toast');
  document.getElementById('toastText').textContent = message;
  toast.classList.add('visible');
  // Auto-hide after 2.5 seconds
  setTimeout(() => toast.classList.remove('visible'), 2500);
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * e.g. "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return '';

  const then = new Date(dateStr);
  const now = new Date();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1)   return 'just now';
  if (diffMins < 60)  return diffMins + ' min ago';
  if (diffHours < 24) return diffHours + ' hr' + (diffHours !== 1 ? 's' : '') + ' ago';
  if (diffDays === 1) return 'yesterday';
  return diffDays + ' days ago';
}

/**
 * getGreeting()
 *
 * Returns an appropriate greeting based on the current hour.
 * Morning = before noon, Afternoon = noon–5pm, Evening = after 5pm.
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning, Zara';
  if (hour < 17) return 'Good afternoon, Zara';
  return 'Good evening, Zara';
}

/**
 * getDateDisplay()
 *
 * Returns a formatted date string like "Friday, April 4, 2026".
 */
function getDateDisplay() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
}

/**
 * countOpenTabsForMission(missionUrls)
 *
 * Counts how many of the user's currently open browser tabs
 * match any of the URLs associated with a mission.
 *
 * We match by domain (hostname) rather than exact URL, because
 * the exact URL often changes (e.g. page IDs, session tokens).
 */
function countOpenTabsForMission(missionUrls) {
  return getOpenTabsForMission(missionUrls).length;
}

/**
 * getOpenTabsForMission(missionUrls)
 *
 * Returns the actual tab objects from openTabs that match
 * any URL in the mission's URL list (matched by domain).
 */
function getOpenTabsForMission(missionUrls) {
  if (!missionUrls || missionUrls.length === 0 || openTabs.length === 0) return [];

  // Extract the domains from the mission's saved URLs
  // missionUrls can be either URL strings or objects with a .url property
  const missionDomains = missionUrls.map(item => {
    const urlStr = (typeof item === 'string') ? item : (item.url || '');
    try {
      return new URL(urlStr.startsWith('http') ? urlStr : 'https://' + urlStr).hostname;
    } catch {
      return urlStr;
    }
  });

  // Find open tabs whose hostname matches any mission domain
  return openTabs.filter(tab => {
    try {
      const tabDomain = new URL(tab.url).hostname;
      return missionDomains.some(d => tabDomain.includes(d) || d.includes(tabDomain));
    } catch {
      return false;
    }
  });
}


/* ----------------------------------------------------------------
   SVG ICON STRINGS

   We store these as a constant so we can reuse them in buttons
   without writing raw SVG every time. Each value is an HTML string
   ready to be injected with innerHTML.
   ---------------------------------------------------------------- */
const ICONS = {
  // Tab/browser icon — used in the "N tabs open" badge
  tabs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,

  // X / close icon — used in "Close N tabs" button
  close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,

  // Archive / trash icon — used in "Close & archive" button
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,

  // Arrow up-right — used in "Focus on this" button
  focus: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`
};


/* ----------------------------------------------------------------
   MISSION CARD RENDERER

   This is the most important function in the file. It takes a
   mission object (from the API) and returns an HTML string for
   one mission card.
   ---------------------------------------------------------------- */

/**
 * renderMissionCard(mission, openTabCount)
 *
 * Builds the full HTML for a single mission card.
 *
 * @param {Object} mission      - Mission object from /api/missions
 * @param {number} openTabCount - How many browser tabs are open for this mission
 * @returns {string}            - HTML string ready for innerHTML
 */
function renderMissionCard(mission, openTabCount) {
  const status = mission.status || 'active';

  // The colored left bar's CSS class matches the status word
  const statusBarClass = status; // 'active', 'cooling', or 'abandoned'

  // The status tag shows either "Active", the cooling age, or the abandoned age
  let tagLabel = '';
  if (status === 'active') {
    tagLabel = 'Active';
  } else {
    // For cooling/abandoned, show a human-friendly age like "1 day" or "2 days"
    tagLabel = timeAgo(mission.last_activity)
      .replace(' ago', '')
      .replace('yesterday', '1 day')
      .replace(' hrs', 'h')
      .replace(' hr', 'h')
      .replace(' min', 'm');
  }

  // Tab badge — only shown if there are open tabs for this mission
  const tabBadge = openTabCount > 0
    ? `<span class="open-tabs-badge" data-mission-id="${mission.id}">
         ${ICONS.tabs}
         ${openTabCount} tab${openTabCount !== 1 ? 's' : ''} open
       </span>`
    : '';

  // Page chips — show up to 4 URLs, truncated to 40 characters each
  const pages = (mission.urls || []).slice(0, 4);
  const pageChips = pages.map(page => {
    // Use the title if available, otherwise the URL
    const label = page.title || page.url || page;
    const display = label.length > 40 ? label.slice(0, 40) + '…' : label;
    return `<span class="page-chip">${display}</span>`;
  }).join('');

  // Meta section (top-right of card): time + page count
  const pageCount = (mission.urls || []).length;
  const metaHtml = `
    <div class="mission-meta">
      <div class="mission-time">${timeAgo(mission.last_activity)}</div>
      <div class="mission-page-count">${pageCount}</div>
      <div class="mission-page-label">pages</div>
    </div>`;

  // Action buttons vary by status:
  // - active: just "Close N tabs" (if tabs open)
  // - cooling: "Focus on this" + "Close N tabs" (if tabs open)
  // - abandoned: "Pick back up" + "Close & archive" (if tabs open) + "Let it go"
  let actionsHtml = '';

  if (status === 'active') {
    if (openTabCount > 0) {
      actionsHtml = `
        <button class="action-btn close-tabs" data-action="close-tabs" data-mission-id="${mission.id}">
          ${ICONS.close}
          Close ${openTabCount} tab${openTabCount !== 1 ? 's' : ''}
        </button>`;
    }
  } else if (status === 'cooling') {
    actionsHtml = `
      <button class="action-btn primary" data-action="focus" data-mission-id="${mission.id}">
        ${ICONS.focus}
        Focus on this
      </button>`;
    if (openTabCount > 0) {
      actionsHtml += `
        <button class="action-btn close-tabs" data-action="close-tabs" data-mission-id="${mission.id}">
          ${ICONS.close}
          Close ${openTabCount} tab${openTabCount !== 1 ? 's' : ''}
        </button>`;
    }
  } else if (status === 'abandoned') {
    actionsHtml = `
      <button class="action-btn primary" data-action="focus" data-mission-id="${mission.id}">
        ${ICONS.focus}
        Pick back up
      </button>`;
    if (openTabCount > 0) {
      actionsHtml += `
        <button class="action-btn close-tabs" data-action="archive" data-mission-id="${mission.id}">
          ${ICONS.archive}
          Close &amp; archive
        </button>`;
    }
    actionsHtml += `
      <button class="action-btn danger" data-action="dismiss" data-mission-id="${mission.id}">
        Let it go
      </button>`;
  }

  return `
    <div class="mission-card" data-mission-id="${mission.id}">
      <div class="status-bar ${statusBarClass}"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${mission.name || 'Unnamed Mission'}</span>
          <span class="mission-tag ${statusBarClass}">${tagLabel}</span>
          ${tabBadge}
        </div>
        <div class="mission-summary">${mission.summary || ''}</div>
        <div class="mission-pages">${pageChips}</div>
        ${actionsHtml ? `<div class="actions">${actionsHtml}</div>` : ''}
      </div>
      ${metaHtml}
    </div>`;
}


/* ----------------------------------------------------------------
   SCATTER BAR RENDERER

   The scatter bar is the 10-dot "focus level" indicator in the
   top-right. It shows how spread out Zara's attention is across
   missions. More missions = more scatter = more dots filled = redder.
   ---------------------------------------------------------------- */

/**
 * renderScatterBar(missionCount)
 *
 * Fills the 10 scatter dots based on how many active missions exist.
 * Over 5 missions = "high scatter" (red dots).
 */
function renderScatterBar(missionCount) {
  const barEl = document.getElementById('scatterBar');
  const captionEl = document.getElementById('scatterCaption');
  if (!barEl || !captionEl) return;

  const isHigh = missionCount > 5;

  // Build 10 dots; fill the first `missionCount` of them
  let dotsHtml = '';
  for (let i = 0; i < 10; i++) {
    const filled = i < missionCount;
    const highClass = filled && isHigh ? ' high' : '';
    dotsHtml += `<div class="scatter-dot${filled ? ' filled' : ''}${highClass}"></div>`;
  }
  barEl.innerHTML = dotsHtml;

  // Caption text
  let level = 'focused';
  if (missionCount > 5) level = 'high scatter';
  else if (missionCount > 2) level = 'moderate scatter';

  captionEl.textContent = `${missionCount} parallel mission${missionCount !== 1 ? 's' : ''} — ${level}`;

  // Caption color: amber normally, rose when high scatter
  captionEl.style.color = isHigh ? 'var(--status-abandoned)' : 'var(--accent-amber)';
}


/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER

   This is called on page load (and again after refresh).
   It fetches all data and paints the full UI.
   ---------------------------------------------------------------- */

/**
 * renderDashboard()
 *
 * Orchestrates everything:
 * 1. Fetch missions from the server
 * 2. Fetch open tabs from the extension
 * 3. Split missions into active vs abandoned
 * 4. Calculate stale tabs (open but belonging to non-active missions)
 * 5. Paint all sections
 */
async function renderDashboard() {
  // --- Header: greeting + date ---
  const greetingEl = document.getElementById('greeting');
  const dateEl = document.getElementById('dateDisplay');
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl) dateEl.textContent = getDateDisplay();

  // --- Fetch missions from Express server ---
  let missions = [];
  try {
    const res = await fetch('/api/missions');
    if (res.ok) {
      missions = await res.json();
    }
  } catch (err) {
    console.warn('[TMC] Could not fetch missions:', err);
  }

  // --- Fetch open tabs from extension ---
  await fetchOpenTabs();

  // --- Split missions into active (active + cooling) and abandoned ---
  const activeMissions    = missions.filter(m => m.status === 'active' || m.status === 'cooling');
  const abandonedMissions = missions.filter(m => m.status === 'abandoned');

  // --- Calculate stale tabs ---
  // A "stale tab" is a browser tab that belongs to a mission that is NOT currently active.
  // These are tabs Zara left open but isn't actively working on — clutter she can clear.
  const activeMissionUrls = new Set(
    activeMissions.flatMap(m => (m.urls || []))
  );

  const staleTabs = openTabs.filter(tab => {
    // Does this tab match any active mission? If not, it's stale.
    const matchesActive = activeMissions.some(m => {
      return getOpenTabsForMission((m.urls || []))
        .some(t => t.url === tab.url);
    });
    return !matchesActive;
  });

  // --- Scatter bar ---
  renderScatterBar(activeMissions.length);

  // --- Cleanup banner (stale tabs) ---
  const cleanupBanner = document.getElementById('cleanupBanner');
  if (staleTabs.length > 0 && cleanupBanner) {
    document.getElementById('staleTabCount').textContent =
      `${staleTabs.length} stale tab${staleTabs.length !== 1 ? 's' : ''}`;
    cleanupBanner.style.display = 'flex';
  } else if (cleanupBanner) {
    cleanupBanner.style.display = 'none';
  }

  // --- Nudge banner (abandoned missions) ---
  const nudgeBanner = document.getElementById('nudgeBanner');
  const nudgeText   = document.getElementById('nudgeText');
  if (abandonedMissions.length > 0 && nudgeBanner && nudgeText) {
    nudgeText.innerHTML = `<strong>${abandonedMissions.length} mission${abandonedMissions.length !== 1 ? 's' : ''} ${abandonedMissions.length === 1 ? 'has' : 'have'} gone cold.</strong> You started ${abandonedMissions.length === 1 ? 'it' : 'them'} but haven't been back in days. Pick one to finish, or let it go.`;
    nudgeBanner.style.display = 'flex';
  } else if (nudgeBanner) {
    nudgeBanner.style.display = 'none';
  }

  // --- Active missions section ---
  const activeSection  = document.getElementById('activeSection');
  const activeMissionsEl = document.getElementById('activeMissions');
  const activeSectionCount = document.getElementById('activeSectionCount');

  if (activeMissions.length > 0 && activeSection) {
    activeSectionCount.textContent = `${activeMissions.length} mission${activeMissions.length !== 1 ? 's' : ''}`;
    activeMissionsEl.innerHTML = activeMissions.map(m => {
      const tabCount = countOpenTabsForMission((m.urls || []));
      return renderMissionCard(m, tabCount);
    }).join('');
    activeSection.style.display = 'block';
  } else if (activeSection) {
    activeSection.style.display = 'none';
  }

  // --- Abandoned missions section ---
  const abandonedSection = document.getElementById('abandonedSection');
  const abandonedMissionsEl = document.getElementById('abandonedMissions');
  const abandonedSectionCount = document.getElementById('abandonedSectionCount');

  if (abandonedMissions.length > 0 && abandonedSection) {
    abandonedSectionCount.textContent = `${abandonedMissions.length} mission${abandonedMissions.length !== 1 ? 's' : ''}`;
    abandonedMissionsEl.innerHTML = abandonedMissions.map(m => {
      const tabCount = countOpenTabsForMission((m.urls || []));
      return renderMissionCard(m, tabCount);
    }).join('');
    abandonedSection.style.display = 'block';
  } else if (abandonedSection) {
    abandonedSection.style.display = 'none';
  }

  // --- Footer stats ---
  const statMissions = document.getElementById('statMissions');
  const statTabs     = document.getElementById('statTabs');
  const statStale    = document.getElementById('statStale');
  if (statMissions) statMissions.textContent = missions.length;
  if (statTabs)     statTabs.textContent = openTabs.length;
  if (statStale)    statStale.textContent = staleTabs.length;

  // --- Last refresh time ---
  // Try to get this from the API (/api/stats), fall back to "just now"
  const lastRefreshEl = document.getElementById('lastRefreshTime');
  if (lastRefreshEl) {
    try {
      const statsRes = await fetch('/api/stats');
      if (statsRes.ok) {
        const stats = await statsRes.json();
        lastRefreshEl.textContent = stats.lastAnalysis
          ? `Last analyzed ${timeAgo(stats.lastAnalysis)}`
          : 'Last analyzed just now';
      } else {
        lastRefreshEl.textContent = 'Last analyzed just now';
      }
    } catch {
      lastRefreshEl.textContent = 'Last analyzed just now';
    }
  }
}


/* ----------------------------------------------------------------
   EVENT HANDLERS (using event delegation)

   Instead of attaching a listener to every button, we attach ONE
   listener to the whole document and check what was clicked.
   This is more efficient and works even after we re-render cards.

   Think of it like one security guard watching the whole building
   instead of one guard per door.
   ---------------------------------------------------------------- */

document.addEventListener('click', async (e) => {
  // Walk up the DOM from the clicked element to find the nearest
  // element with a data-action attribute
  const actionEl = e.target.closest('[data-action]');

  // --- Close all stale tabs button (in the cleanup banner) ---
  if (e.target.closest('#closeAllStaleBtn')) {
    e.preventDefault();
    await handleCloseAllStale();
    return;
  }

  // --- Refresh button (in the footer) ---
  if (e.target.closest('#refreshBtn')) {
    e.preventDefault();
    await handleRefresh();
    return;
  }

  if (!actionEl) return; // click wasn't on an action button

  const action    = actionEl.dataset.action;
  const missionId = actionEl.dataset.missionId;

  // Find the card element so we can animate it
  const card = actionEl.closest('.mission-card');

  // ---- close-tabs: close all tabs belonging to this mission ----
  if (action === 'close-tabs') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await closeTabsByUrls(urls);

    // Remove the badge from the card (no tabs left open)
    if (card) {
      const badge = card.querySelector('.open-tabs-badge');
      if (badge) {
        badge.style.transition = 'opacity 0.3s, transform 0.3s';
        badge.style.opacity = '0';
        badge.style.transform = 'scale(0.8)';
        setTimeout(() => badge.remove(), 300);
      }
      // Remove this specific close-tabs button
      actionEl.style.transition = 'opacity 0.2s';
      actionEl.style.opacity = '0';
      setTimeout(() => actionEl.remove(), 200);
    }

    // Update footer stale count
    await updateStaleCount();
    showToast(`Closed tabs for "${mission.name}"`);
  }

  // ---- archive: close tabs + mark mission as archived, then remove card ----
  else if (action === 'archive') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await closeTabsByUrls(urls);

    // Tell the server to archive this mission
    try {
      await fetch(`/api/missions/${missionId}/archive`, { method: 'POST' });
    } catch (err) {
      console.warn('[TMC] Could not archive mission:', err);
    }

    // Animate the card out
    if (card) {
      card.classList.add('closing');
      setTimeout(() => card.remove(), 400);
    }

    showToast(`Archived "${mission.name}"`);
    await updateStaleCount();
  }

  // ---- dismiss: close tabs (if any), mark as dismissed, remove card ----
  else if (action === 'dismiss') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    // If tabs are open, close them first
    const tabCount = card
      ? (card.querySelector('.open-tabs-badge')?.textContent.match(/\d+/)?.[0] || 0)
      : 0;

    if (parseInt(tabCount) > 0) {
      const urls = (mission.urls || []).map(u => u.url);
      await closeTabsByUrls(urls);
    }

    // Tell the server this mission is dismissed
    try {
      await fetch(`/api/missions/${missionId}/dismiss`, { method: 'POST' });
    } catch (err) {
      console.warn('[TMC] Could not dismiss mission:', err);
    }

    // Animate the card out
    if (card) {
      card.classList.add('closing');
      setTimeout(() => card.remove(), 400);
    }

    showToast(`Let go of "${mission.name}"`);
    await updateStaleCount();
  }

  // ---- focus: bring the mission's tabs to the front ----
  else if (action === 'focus') {
    const mission = await fetchMissionById(missionId);
    if (!mission) return;

    const urls = (mission.urls || []).map(u => u.url);
    await focusTabsByUrls(urls);
    showToast(`Focused on "${mission.name}"`);
  }
});


/* ----------------------------------------------------------------
   ACTION HELPERS
   ---------------------------------------------------------------- */

/**
 * handleCloseAllStale()
 *
 * Closes ALL tabs that belong to non-active missions at once.
 * This is the nuclear option — Zara hits "Close all stale tabs"
 * and everything from abandoned/cold missions gets cleared.
 */
async function handleCloseAllStale() {
  // Collect all missions, find tabs for non-active ones
  let missions = [];
  try {
    const res = await fetch('/api/missions');
    if (res.ok) missions = await res.json();
  } catch { /* silent fail */ }

  const nonActiveMissions = missions.filter(m => m.status !== 'active');
  const urlsToClose = nonActiveMissions.flatMap(m => (m.urls || []));

  await closeTabsByUrls(urlsToClose);

  // Remove all stale badges and close-tab buttons from the DOM
  document.querySelectorAll('.open-tabs-badge').forEach(badge => {
    // Only remove if the badge's parent card is NOT an active mission
    const card = badge.closest('.mission-card');
    const isActive = card?.querySelector('.mission-tag.active');
    if (!isActive) {
      badge.style.transition = 'opacity 0.3s';
      badge.style.opacity = '0';
      setTimeout(() => badge.remove(), 300);
    }
  });

  document.querySelectorAll('.action-btn.close-tabs').forEach(btn => {
    const card = btn.closest('.mission-card');
    const isActive = card?.querySelector('.mission-tag.active');
    if (!isActive) {
      btn.style.transition = 'opacity 0.2s';
      btn.style.opacity = '0';
      setTimeout(() => btn.remove(), 200);
    }
  });

  // Hide the cleanup banner
  const banner = document.getElementById('cleanupBanner');
  if (banner) {
    banner.style.transition = 'opacity 0.4s';
    banner.style.opacity = '0';
    setTimeout(() => { banner.style.display = 'none'; }, 400);
  }

  // Update stale count in footer
  const statStale = document.getElementById('statStale');
  const statTabs  = document.getElementById('statTabs');
  if (statStale) statStale.textContent = '0';
  if (statTabs)  statTabs.textContent = openTabs.length;

  showToast('Closed all stale tabs. Breathing room restored.');
}

/**
 * handleRefresh()
 *
 * Triggers a fresh AI analysis of the browser history,
 * then re-renders the dashboard with the new data.
 */
async function handleRefresh() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) {
    refreshBtn.textContent = 'Refreshing…';
    refreshBtn.style.opacity = '0.5';
  }

  try {
    // Ask the server to re-read history + re-cluster missions
    await fetch('/api/missions/refresh', { method: 'POST' });
  } catch (err) {
    console.warn('[TMC] Refresh failed:', err);
  }

  // Re-render the full dashboard
  await renderDashboard();

  if (refreshBtn) {
    refreshBtn.textContent = 'Refresh now';
    refreshBtn.style.opacity = '1';
  }
}

/**
 * fetchMissionById(missionId)
 *
 * Fetches a single mission object by ID from the server.
 * We need this when handling button clicks, so we have the mission's
 * page URLs and name ready.
 *
 * Returns null if the fetch fails.
 */
async function fetchMissionById(missionId) {
  try {
    const res = await fetch('/api/missions');
    if (!res.ok) return null;
    const missions = await res.json();
    return missions.find(m => String(m.id) === String(missionId)) || null;
  } catch {
    return null;
  }
}

/**
 * updateStaleCount()
 *
 * Recalculates and updates the stale tab count in the footer
 * and cleanup banner after an action (e.g. closing some tabs).
 */
async function updateStaleCount() {
  await fetchOpenTabs(); // refresh our tab list first

  let missions = [];
  try {
    const res = await fetch('/api/missions');
    if (res.ok) missions = await res.json();
  } catch { /* silent fail */ }

  const activeMissions = missions.filter(m => m.status === 'active' || m.status === 'cooling');

  const staleTabs = openTabs.filter(tab => {
    const matchesActive = activeMissions.some(m => {
      return getOpenTabsForMission((m.urls || []))
        .some(t => t.url === tab.url);
    });
    return !matchesActive;
  });

  const statStale = document.getElementById('statStale');
  const statTabs  = document.getElementById('statTabs');
  if (statStale) statStale.textContent = staleTabs.length;
  if (statTabs)  statTabs.textContent = openTabs.length;

  // Update banner text
  const staleTabCountEl = document.getElementById('staleTabCount');
  const cleanupBanner   = document.getElementById('cleanupBanner');
  if (staleTabs.length > 0) {
    if (staleTabCountEl) staleTabCountEl.textContent = `${staleTabs.length} stale tab${staleTabs.length !== 1 ? 's' : ''}`;
    if (cleanupBanner) cleanupBanner.style.display = 'flex';
  } else {
    if (cleanupBanner) {
      cleanupBanner.style.transition = 'opacity 0.4s';
      cleanupBanner.style.opacity = '0';
      setTimeout(() => { cleanupBanner.style.display = 'none'; cleanupBanner.style.opacity = '1'; }, 400);
    }
  }
}


/* ----------------------------------------------------------------
   INITIALIZE

   When the page loads, paint the dashboard immediately.
   ---------------------------------------------------------------- */
renderDashboard();
