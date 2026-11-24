'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../extension/app.js'), 'utf8');
const url = 'https://example.test/a';
const other = 'https://example.test/b';
const tab = (id, extra = {}) => ({
  id, url, title: 'Example', windowId: 1, groupId: -1, ...extra,
});

function harness(tabs, view = 'ungrouped', { beforeQuery, rejectId } = {}) {
  const removals = [];
  const toasts = [];
  const state = tabs.map(t => ({ ...t }));
  let queryCount = 0;
  let renderCount = 0;
  let closeSounds = 0;
  let latest;
  let pageClick;
  const context = vm.createContext({
    URL,
    document: {
      addEventListener: (type, cb) => {
        if (type === 'click' && !pageClick) pageClick = cb;
      },
    },
    chrome: {
      runtime: { id: 'synthetic' },
      tabs: {
        query: async () => {
          beforeQuery?.(++queryCount, state);
          return state.map(t => ({ ...t }));
        },
        remove: async id => {
          if (id === rejectId) throw Error('synthetic removal failure');
          const i = state.findIndex(t => t.id === id);
          assert.notEqual(i, -1);
          removals.push(id);
          state.splice(i, 1);
        },
      },
    },
    toast: msg => toasts.push(msg),
    sound: () => ++closeSounds,
    rendered: html => { latest = html; ++renderCount; },
  });
  // Keep the actual action listener and renderers; disable startup polling
  // and substitute Chrome/UI side effects at those boundaries.
  assert.match(app, /renderDashboard\(\);\s*$/);
  vm.runInContext(app.replace(/renderDashboard\(\);\s*$/, ''), context);
  const renderer = {
    group: 'renderTabGroupCard({ id: 8, color: "blue" }, openTabs.filter(t => t.groupId === 8))',
    ungrouped: 'renderUngroupedSection(openTabs.filter(t => t.groupId === -1))',
    domain: 'renderDomainCard({ domain: "example.test", tabs: openTabs.filter(t => new URL(t.url).hostname === "example.test") })',
  }[view];
  vm.runInContext(`
    showToast = toast;
    playCloseSound = sound;
    renderDashboard = async () => {
      await fetchOpenTabs();
      rendered(${renderer});
    };
  `, context);

  const button = () => {
    const match = latest.match(/data-action="dedup-keep-one" data-duplicate-scope="([^"]+)">([^<]+)/);
    return match ? {
      dataset: { action: 'dedup-keep-one', duplicateScope: match[1] },
      closest: () => null,
      text: match[2],
    } : null;
  };
  return {
    removals, toasts, state, button,
    render: () => vm.runInContext('renderDashboard()', context),
    click: (target = button()) => pageClick({ target: { closest: () => target } }),
    renderCount: () => renderCount,
    closeSounds: () => closeSounds,
    html: () => latest,
  };
}

test('group button closes only its own duplicate and keeps the other group', async () => {
  const h = harness([
    tab(1, { groupId: 8 }), tab(2, { groupId: 8 }),
    tab(3, { groupId: 9, active: true }), tab(4),
  ], 'group');
  await h.render();
  assert.equal(h.button().text, 'Close 1 duplicate');
  await h.click();
  assert.deepEqual(h.removals, [2]);
  assert.deepEqual(h.state.map(t => t.id), [1, 3, 4]);
  assert.equal(h.button(), null);
  assert.deepEqual(h.toasts, ['Closed 1 duplicate tab.']);
});

test('ungrouped action retains inactive pinned copies and does not touch grouped copies', async () => {
  const h = harness([tab(1, { pinned: true }), tab(2, { active: true }),
    tab(3, { pinned: true }), tab(4, { groupId: 8 })]);
  await h.render();
  assert.equal(h.button().text, 'Close 1 duplicate');
  await h.click();
  assert.deepEqual(h.removals, [2]);
  assert.equal(h.button(), null);
  assert.match(h.html(), /chip-dupe-badge/);
});

test('domain button retains a lone tab and never closes a multi-URL window', async () => {
  const h = harness([
    tab(1, { active: true }), tab(2, { url: other }),
    tab(3, { windowId: 2, active: true }), tab(4, { windowId: 2, url: other }),
    tab(5, { windowId: 3, active: true, url: other }), tab(6, { url: other }),
  ], 'domain');
  await h.render();
  assert.equal(h.button().text, 'Close 3 duplicates');
  await h.click();
  assert.deepEqual(h.removals, [2, 4, 6]);
  assert.deepEqual(h.state.map(t => [t.id, t.windowId]), [[1, 1], [3, 2], [5, 3]]);
});

test('a stale group snapshot cannot close a moved or navigated tab or a new copy', async () => {
  const h = harness([tab(1, { groupId: 8, active: true }), tab(2, { groupId: 8 }),
    tab(3, { groupId: 8 }), tab(4, { groupId: 8 })], 'group');
  await h.render();
  const stale = h.button();
  h.state[1].groupId = 9;
  h.state[2].pendingUrl = 'https://example.test/changed';
  h.state[3].url = 'https://example.test/changed';
  h.state.push(tab(5, { groupId: 8 }));
  await h.click(stale);
  assert.deepEqual(h.removals, []);
  assert.deepEqual(h.toasts, ['No duplicate tabs closed.']);
  assert.equal(h.closeSounds(), 0);
  assert.equal(h.renderCount(), 2);
});

test('rechecks protection before removal and prevents re-entrant clicks', async () => {
  const h = harness([tab(1, { pinned: true }), tab(2), tab(3), tab(4)], 'ungrouped', {
    beforeQuery: (n, state) => { if (n === 4) state.find(t => t.id === 3).pinned = true; },
  });
  await h.render();
  const target = h.button();
  await Promise.all([h.click(target), h.click(target)]);
  assert.deepEqual(h.removals, [2, 4]);
  assert.deepEqual(h.toasts, ['Closed 2 duplicate tabs.']);
});

test('reports only successful removes and refreshes leftover duplicates', async () => {
  const h = harness([tab(1, { active: true }), tab(2), tab(3)], 'ungrouped', { rejectId: 2 });
  await h.render();
  await h.click();
  assert.deepEqual(h.removals, [3]);
  assert.deepEqual(h.toasts, ['Closed 1 duplicate tab. Some tabs could not be checked or closed.']);
  assert.equal(h.button().text, 'Close 1 duplicate');
});

test('does not offer to close copies when all are protected', async () => {
  const h = harness([tab(1, { pinned: true }), tab(2, { windowId: 2, active: true })]);
  await h.render();
  assert.equal(h.button(), null);
  assert.match(h.html(), /chip-dupe-badge/);
});
