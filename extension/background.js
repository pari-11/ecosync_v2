const API = 'http://localhost:8000';
const HEAVY_THRESHOLD_MINS = 1 / 6;
const DOWNLOAD_POLL_MS = 1000;
const COMMAND_POLL_MS = 1000;
const GRID_CACHE_MS = 4000;
const DOWNLOAD_PUSH_DEBOUNCE_MS = 150;

let heavyTabs = [];
let tabClassification = {};
let overlayLastShown = null;
let overlaySuppressed = false;
let sessionCO2 = 0;

const OVERLAY_COOLDOWN_MS = 30 * 60 * 1000;

let downloadsState = {
  gridState: 'unknown',
  pendingDecision: null,
  current: null,
  deferred: [],
  ledger: [],
  savedCO2: 0,
  cancelledCount: 0
};

const downloadStore = new Map();
let downloadsPollTimer = null;
let commandPollTimer = null;

let lastGridSnapshot = {
  intensity: 0,
  gridState: 'unknown',
  fetchedAt: 0
};

let downloadPushTimer = null;

function classifyTab(tab) {
  if (!tab || !tab.url) return;

  const url = tab.url.toLowerCase();
  const isAudible = tab.audible || false;
  let weight = 'static';

  if (
    url.includes('youtube.com') || url.includes('twitch.tv') ||
    url.includes('netflix.com') || url.includes('hotstar.com') ||
    url.includes('primevideo.com') || url.includes('jiocinema.com')
  ) {
    weight = isAudible ? 'heavy-video' : 'heavy';
  } else if (
    url.includes('twitter.com') || url.includes('x.com') ||
    url.includes('instagram.com') || url.includes('facebook.com') ||
    url.includes('reddit.com') || url.includes('slack.com') ||
    url.includes('teams.microsoft.com') || url.includes('mail.google.com') ||
    url.includes('discord.com') || url.includes('web.whatsapp.com')
  ) {
    weight = 'dynamic';
  } else if (
    url.includes('docs.google.com') || url.includes('stackoverflow.com') ||
    url.includes('wikipedia.org') || url.includes('github.com') ||
    url.includes('notion.so') || url.includes('medium.com')
  ) {
    weight = 'static';
  }

  tabClassification[tab.id] = {
    id: tab.id,
    title: tab.title || tab.url,
    url: tab.url,
    weight,
    audible: isAudible,
    active: !!tab.active,
    background: !tab.active,
    lastFocusedMinutes: 0,
    inactiveMinutes: 0,
    pollingRequests: weight === 'dynamic' ? 1 : 0,
    power: getPowerEstimate(weight)
  };

  if (weight === 'heavy' || weight === 'heavy-video') {
    if (!heavyTabs.includes(tab.id)) heavyTabs.push(tab.id);
    scheduleHeavyAlarm(tab.id);
  } else {
    heavyTabs = heavyTabs.filter((id) => id !== tab.id);
    cancelHeavyAlarm(tab.id);
  }
}

function getPowerEstimate(weight) {
  return { static: 0.5, dynamic: 5, heavy: 10, 'heavy-video': 15 }[weight] || 0.5;
}

function scheduleHeavyAlarm(tabId) {
  const alarmName = `heavy-tab-${tabId}`;
  chrome.alarms.get(alarmName, (existing) => {
    if (!existing) chrome.alarms.create(alarmName, { delayInMinutes: HEAVY_THRESHOLD_MINS });
  });
}

function cancelHeavyAlarm(tabId) {
  chrome.alarms.clear(`heavy-tab-${tabId}`);
}

function estimateZombieCO2(carbonIntensity) {
  const allTabs = Object.values(tabClassification).filter(Boolean);
  return allTabs
    .filter((t) => t.background)
    .reduce((sum, t) => sum + ((Number(t.power || 0) * Number(carbonIntensity || 0)) / 1000) / 4, 0);
}

function pushStateToBackend(carbonIntensity, co2Rate, totalPower, heavyCount) {
  const allTabs = Object.values(tabClassification).filter(Boolean);
  fetch(`${API}/api/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tabs: allTabs,
      heavyCount,
      totalPower,
      carbonIntensity,
      co2Rate,
      sessionCO2,
      pollingRequests60s: allTabs.filter((t) => t.weight === 'dynamic').length,
      zombieCO2: estimateZombieCO2(carbonIntensity),
      updatedAt: new Date().toISOString()
    })
  }).catch(() => {});
}

function setGridStateFromIntensity(intensity) {
  if (intensity >= 400) return 'red';
  if (intensity >= 200) return 'yellow';
  return 'green';
}

function formatCarbon(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}kg CO₂` : `${value.toFixed(2)}g CO₂`;
}

function estimateCarbonForDownload(item) {
  const downloadedMB = Number(item.bytesReceived || 0) / (1024 * 1024);
  const intensity = Number(item.gridIntensity || 0);
  return Math.max(0, downloadedMB * (intensity / 1000) * 10);
}

function estimateTotalCarbonForDownload(item) {
  const sizeMB = Number(item.totalBytes || 0) / (1024 * 1024);
  const intensity = Number(item.gridIntensity || 0);
  return Math.max(0, sizeMB * (intensity / 1000) * 10);
}

function getSpeedBps(item) {
  const now = Date.now();
  const elapsedSec = Math.max(1, (now - (item.startTime || now)) / 1000);
  return Number(item.bytesReceived || 0) / elapsedSec;
}

function getEtaSeconds(item, speedBps) {
  const remaining = Math.max(0, Number(item.totalBytes || 0) - Number(item.bytesReceived || 0));
  if (!speedBps || speedBps <= 0) return 0;
  return remaining / speedBps;
}

function speedLabel(item) {
  const bps = getSpeedBps(item);
  if (!bps) return '--';
  return `${(bps / (1024 * 1024)).toFixed(1)} MB/s`;
}

function etaLabel(item) {
  const eta = getEtaSeconds(item, getSpeedBps(item));
  if (!eta || !isFinite(eta)) return '--';
  return `${Math.ceil(eta)}s left`;
}

function fileSizeLabel(bytes) {
  if (!bytes || bytes <= 0) return '--';
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatResumeWindow(date) {
  const now = new Date();
  const sameDay = now.toDateString() === date.toDateString();
  const dayLabel = sameDay ? 'Today' : date.toLocaleDateString([], { weekday: 'short' });
  const timeLabel = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${dayLabel}, ${timeLabel}`;
}

function getNextGreenWindow(gridState) {
  const now = new Date();

  if (gridState === 'green') {
    const d = new Date(now.getTime() + 15 * 60 * 1000);
    return { resumeAt: d.toISOString(), resumeAtLabel: formatResumeWindow(d) };
  }

  if (gridState === 'yellow') {
    const d = new Date(now.getTime() + 90 * 60 * 1000);
    return { resumeAt: d.toISOString(), resumeAtLabel: formatResumeWindow(d) };
  }

  const d = new Date(now);
  if (now.getHours() < 2) {
    d.setHours(3, 0, 0, 0);
  } else {
    d.setDate(d.getDate() + 1);
    d.setHours(3, 0, 0, 0);
  }
  return { resumeAt: d.toISOString(), resumeAtLabel: formatResumeWindow(d) };
}

async function fetchGridCarbon(force = false) {
  const now = Date.now();
  if (!force && lastGridSnapshot.fetchedAt && (now - lastGridSnapshot.fetchedAt) < GRID_CACHE_MS) {
    return {
      intensity: lastGridSnapshot.intensity,
      gridState: lastGridSnapshot.gridState
    };
  }

  try {
    const res = await fetch(`${API}/api/carbon/live/in`);
    const data = await res.json();
    const intensity = Number(data.intensity || 0);
    const gridState = data.trafficLight || setGridStateFromIntensity(intensity);

    lastGridSnapshot = {
      intensity,
      gridState,
      fetchedAt: Date.now()
    };

    return { intensity, gridState };
  } catch (_) {
    return {
      intensity: lastGridSnapshot.intensity || 0,
      gridState: lastGridSnapshot.gridState || downloadsState.gridState || 'unknown'
    };
  }
}

function ensureDownloadRecord(item) {
  const existing = downloadStore.get(item.id) || {};
  const next = {
    id: item.id,
    fileName: existing.fileName || item.filename?.split(/[\\/]/).pop() || item.filename || item.finalUrl || 'Unknown File',
    filename: item.filename || existing.filename || '',
    finalUrl: item.finalUrl || existing.finalUrl || '',
    totalBytes: typeof item.totalBytes === 'number' ? item.totalBytes : (existing.totalBytes || 0),
    bytesReceived: typeof item.bytesReceived === 'number' ? item.bytesReceived : (existing.bytesReceived || 0),
    state: item.state || existing.state || 'in_progress',
    paused: typeof item.paused === 'boolean' ? item.paused : !!existing.paused,
    exists: typeof item.exists === 'boolean' ? item.exists : existing.exists,
    canResume: typeof item.canResume === 'boolean' ? item.canResume : existing.canResume,
    startTime: existing.startTime || Date.now(),
    gridIntensity: existing.gridIntensity || lastGridSnapshot.intensity || 0,
    gridState: existing.gridState || lastGridSnapshot.gridState || downloadsState.gridState || 'unknown',
    liveCarbon: existing.liveCarbon || 0,
    deferred: !!existing.deferred,
    awaitingDecision: !!existing.awaitingDecision,
    decisionCreatedAt: existing.decisionCreatedAt || null,
    resumeAt: existing.resumeAt || null,
    resumeAtLabel: existing.resumeAtLabel || null,
    lastUpdated: Date.now()
  };

  downloadStore.set(item.id, next);
  return next;
}

function buildDownloadRow(item) {
  const progress = item.totalBytes > 0 ? (item.bytesReceived / item.totalBytes) * 100 : 0;
  return {
    id: item.id,
    fileName: item.fileName || 'Unknown File',
    fileSizeLabel: fileSizeLabel(item.totalBytes),
    speedLabel: speedLabel(item),
    etaLabel: etaLabel(item),
    progress,
    carbonTicker: formatCarbon(item.liveCarbon || 0),
    carbonCost: formatCarbon(estimateTotalCarbonForDownload(item)),
    currentCO2: Number(item.liveCarbon || 0),
    gridState: item.gridState || downloadsState.gridState || 'unknown',
    status: item.awaitingDecision
      ? 'awaiting-decision'
      : item.deferred
        ? 'deferred'
        : item.paused
          ? 'paused'
          : item.state === 'complete'
            ? 'complete'
            : 'downloading',
    awaitingDecision: !!item.awaitingDecision,
    resumeAt: item.resumeAt || null,
    resumeAtLabel: item.resumeAtLabel || null,
    canResume: !!item.canResume
  };
}

function getPendingDecisionItem() {
  const pending = [...downloadStore.values()]
    .filter((item) =>
      item &&
      item.awaitingDecision &&
      item.state !== 'complete' &&
      item.state !== 'cancelled'
    )
    .sort((a, b) => (b.decisionCreatedAt || 0) - (a.decisionCreatedAt || 0));

  if (!pending.length) return null;
  return buildDownloadRow(pending[0]);
}

function scheduleDownloadStatePush() {
  if (downloadPushTimer) clearTimeout(downloadPushTimer);
  downloadPushTimer = setTimeout(() => {
    pushDownloadStateToBackend();
    downloadPushTimer = null;
  }, DOWNLOAD_PUSH_DEBOUNCE_MS);
}

async function refreshDownloadStoreFromChrome() {
  return new Promise((resolve) => {
    chrome.downloads.search({}, async (items) => {
      const { intensity, gridState } = await fetchGridCarbon();
      downloadsState.gridState = gridState;

      for (const item of items) {
        if (!item || typeof item.id !== 'number') continue;

        const rec = ensureDownloadRecord(item);
        rec.fileName = item.filename?.split(/[\\/]/).pop() || rec.fileName;
        rec.filename = item.filename || rec.filename;
        rec.finalUrl = item.finalUrl || rec.finalUrl;
        rec.totalBytes = typeof item.totalBytes === 'number' ? item.totalBytes : rec.totalBytes;
        rec.bytesReceived = typeof item.bytesReceived === 'number' ? item.bytesReceived : rec.bytesReceived;
        rec.state = item.state || rec.state;
        rec.paused = typeof item.paused === 'boolean' ? item.paused : rec.paused;
        rec.exists = item.exists;
        rec.canResume = item.canResume;
        rec.gridIntensity = intensity;
        rec.gridState = gridState;
        rec.liveCarbon = estimateCarbonForDownload(rec);
        rec.lastUpdated = Date.now();

        if (rec.state === 'complete' || rec.state === 'cancelled' || rec.state === 'interrupted') {
          rec.awaitingDecision = false;
        }

        downloadStore.set(item.id, rec);
      }

      syncDownloadState({ skipBackendPush: true });
      scheduleDownloadStatePush();
      resolve();
    });
  });
}

function getCurrentDownloadingItem() {
  const candidates = [...downloadStore.values()].filter((item) =>
    item &&
    item.state === 'in_progress' &&
    !item.paused &&
    !item.deferred &&
    !item.awaitingDecision
  );

  if (!candidates.length) return null;

  candidates.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
  return candidates[0];
}

function getDeferredItems() {
  return [...downloadStore.values()]
    .filter((item) => item && item.deferred)
    .sort((a, b) => (b.lastUpdated || 0) - (a.lastUpdated || 0))
    .map(buildDownloadRow);
}

function hasTrackedActiveDownloads() {
  return [...downloadStore.values()].some((item) =>
    item &&
    (
      (item.state === 'in_progress' && !item.paused && !item.deferred && !item.awaitingDecision) ||
      item.deferred ||
      item.awaitingDecision
    )
  );
}

function ensureDownloadsPolling() {
  if (downloadsPollTimer) return;
  downloadsPollTimer = setInterval(async () => {
    await refreshDownloadStoreFromChrome();
    if (!hasTrackedActiveDownloads()) {
      clearInterval(downloadsPollTimer);
      downloadsPollTimer = null;
    }
  }, DOWNLOAD_POLL_MS);
}

function syncDownloadState({ skipBackendPush = false } = {}) {
  downloadsState.pendingDecision = getPendingDecisionItem();
  const current = getCurrentDownloadingItem();
  downloadsState.current = current ? buildDownloadRow(current) : null;
  downloadsState.deferred = getDeferredItems();
  chrome.storage.local.set({ ecosyncDownloadsState: downloadsState }).catch(() => {});
  if (!skipBackendPush) {
    scheduleDownloadStatePush();
  }
}

function pushDownloadStateToBackend() {
  fetch(`${API}/api/downloads/state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(downloadsState)
  }).catch(() => {});
}

async function executeDownloadAction(actionType, id) {
  const numericId = Number(id);
  const item = downloadStore.get(numericId);
  if (!item) return { ok: false, error: 'Download not found' };

  if (actionType === 'pause') {
    try {
      await chrome.downloads.pause(numericId);
      item.paused = true;
      item.deferred = false;
      item.awaitingDecision = false;
      item.resumeAt = null;
      item.resumeAtLabel = null;
      downloadsState.ledger.unshift({
        date: new Date().toLocaleString(),
        fileName: item.fileName,
        action: 'Paused',
        carbon: formatCarbon(item.liveCarbon || 0)
      });
      downloadStore.set(numericId, item);
      syncDownloadState();
      ensureDownloadsPolling();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  if (actionType === 'defer') {
    try {
      await chrome.downloads.pause(numericId);
      item.paused = true;
      item.deferred = true;
      item.awaitingDecision = false;
      const greenWindow = getNextGreenWindow(downloadsState.gridState || item.gridState || 'unknown');
      item.resumeAt = greenWindow.resumeAt;
      item.resumeAtLabel = greenWindow.resumeAtLabel;

      const saved = Math.max(0, estimateTotalCarbonForDownload(item) - (item.liveCarbon || 0));
      downloadsState.savedCO2 += saved;
      downloadsState.ledger.unshift({
        date: new Date().toLocaleString(),
        fileName: item.fileName,
        action: `Deferred · resumes around ${item.resumeAtLabel}`,
        carbon: `Saved ${formatCarbon(saved)}`
      });
      downloadStore.set(numericId, item);
      syncDownloadState();
      ensureDownloadsPolling();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  if (actionType === 'resume') {
    try {
      await chrome.downloads.resume(numericId);
      item.paused = false;
      item.deferred = false;
      item.awaitingDecision = false;
      item.resumeAt = null;
      item.resumeAtLabel = null;
      item.state = 'in_progress';
      downloadsState.ledger.unshift({
        date: new Date().toLocaleString(),
        fileName: item.fileName,
        action: 'Resumed manually',
        carbon: formatCarbon(item.liveCarbon || 0)
      });
      downloadStore.set(numericId, item);
      syncDownloadState();
      ensureDownloadsPolling();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  if (actionType === 'cancel') {
    try {
      await chrome.downloads.cancel(numericId);
      item.state = 'cancelled';
      item.paused = false;
      item.deferred = false;
      item.awaitingDecision = false;
      item.resumeAt = null;
      item.resumeAtLabel = null;
      downloadsState.cancelledCount = (downloadsState.cancelledCount || 0) + 1;
      downloadsState.ledger.unshift({
        date: new Date().toLocaleString(),
        fileName: item.fileName,
        action: 'Cancelled',
        carbon: formatCarbon(item.liveCarbon || 0)
      });
      downloadStore.set(numericId, item);
      syncDownloadState();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message || e) };
    }
  }

  return { ok: false, error: 'Unknown action' };
}

async function pollBackendDownloadCommands() {
  try {
    const res = await fetch(`${API}/api/downloads/commands`);
    if (!res.ok) return;

    const data = await res.json();
    if (!data || !data.command) return;

    const { action, download_id } = data.command;
    if (!action || typeof download_id === 'undefined' || download_id === null) return;

    await executeDownloadAction(action, download_id);
  } catch (_) {}
}

function ensureCommandPolling() {
  if (commandPollTimer) return;
  commandPollTimer = setInterval(() => {
    pollBackendDownloadCommands();
  }, COMMAND_POLL_MS);
}

chrome.downloads.onCreated.addListener(async (item) => {
  const rec = ensureDownloadRecord(item);
  const grid = await fetchGridCarbon();

  rec.gridIntensity = grid.intensity;
  rec.gridState = grid.gridState;
  rec.awaitingDecision = true;
  rec.decisionCreatedAt = Date.now();
  rec.paused = true;
  rec.state = item.state || 'in_progress';
  downloadStore.set(item.id, rec);

  try {
    await chrome.downloads.pause(item.id);
  } catch (_) {}

  syncDownloadState();
  await refreshDownloadStoreFromChrome();
  ensureDownloadsPolling();

  chrome.action.setBadgeText({ text: '1' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#01696f' }).catch(() => {});
});

chrome.downloads.onChanged.addListener((delta) => {
  const current = downloadStore.get(delta.id) || { id: delta.id, startTime: Date.now() };

  if (delta.filename?.current) {
    current.filename = delta.filename.current;
    current.fileName = delta.filename.current.split(/[\\/]/).pop();
  }
  if (typeof delta.totalBytes?.current === 'number') current.totalBytes = delta.totalBytes.current;
  if (typeof delta.bytesReceived?.current === 'number') current.bytesReceived = delta.bytesReceived.current;
  if (typeof delta.paused?.current === 'boolean') current.paused = delta.paused.current;
  if (delta.state?.current) current.state = delta.state.current;
  if (typeof delta.exists?.current === 'boolean') current.exists = delta.exists.current;
  if (typeof delta.canResume?.current === 'boolean') current.canResume = delta.canResume.current;

  current.gridIntensity = lastGridSnapshot.intensity || current.gridIntensity || 0;
  current.gridState = lastGridSnapshot.gridState || current.gridState || downloadsState.gridState || 'unknown';
  current.liveCarbon = estimateCarbonForDownload(current);
  current.lastUpdated = Date.now();

  if (current.state === 'complete' || current.state === 'cancelled' || current.state === 'interrupted') {
    current.awaitingDecision = false;
  }

  downloadStore.set(delta.id, current);

  syncDownloadState();

  const pending = getPendingDecisionItem();
  chrome.action.setBadgeText({ text: pending ? '1' : '' }).catch(() => {});

  if (current.state === 'in_progress' || current.paused || current.deferred || current.awaitingDecision) {
    ensureDownloadsPolling();
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' || changeInfo.audible !== undefined) classifyTab(tab);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  Object.values(tabClassification).forEach((tab) => {
    if (!tab) return;
    tab.active = tab.id === tabId;
    tab.background = tab.id !== tabId;
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete tabClassification[tabId];
  heavyTabs = heavyTabs.filter((id) => id !== tabId);
  cancelHeavyAlarm(tabId);
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getHeavyTabs') {
    sendResponse({
      heavyCount: heavyTabs.length,
      heavyTabs: heavyTabs.map((id) => tabClassification[id]).filter(Boolean),
      allTabs: Object.values(tabClassification)
    });
    return true;
  }

  if (request.action === 'suppressOverlay') {
    overlaySuppressed = true;
    sendResponse({ ok: true });
    return true;
  }

  if (request.action === 'getSessionCO2') {
    sendResponse({ total: sessionCO2 });
    return true;
  }

  if (request.action === 'getCarbonSnapshot') {
    sendResponse({
      intensity: lastGridSnapshot.intensity,
      trafficLight: lastGridSnapshot.gridState,
      timestamp: lastGridSnapshot.fetchedAt
    });
    return true;
  }

  if (request.action === 'downloads-action') {
    executeDownloadAction(request.actionType, request.id).then((result) => {
      chrome.storage.local.get('ecosyncDownloadsState', (store) => {
        const latest = store?.ecosyncDownloadsState || downloadsState;
        sendResponse({ ...result, state: latest });
      });
    });
    return true;
  }

  if (request.action === 'getDownloadsState') {
    sendResponse(downloadsState);
    return true;
  }

  return false;
});

chrome.tabs.query({}, (tabs) => {
  tabs.forEach((tab) => classifyTab(tab));
});

chrome.alarms.create('ecosync-state-push', { periodInMinutes: 1 / 6 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('heavy-tab-')) return;

  const tabId = parseInt(alarm.name.replace('heavy-tab-', ''), 10);

  chrome.tabs.get(tabId, async (tab) => {
    if (chrome.runtime.lastError || !tab) return;

    const tabData = tabClassification[tabId];
    if (!tabData || (tabData.weight !== 'heavy' && tabData.weight !== 'heavy-video')) return;

    const allTabs = Object.values(tabClassification).filter(Boolean);
    const heavyCount = allTabs.filter((t) => t.weight === 'heavy' || t.weight === 'heavy-video').length;
    const totalPower = allTabs.reduce((s, t) => s + t.power, 0).toFixed(1);

    let carbonIntensity = 0;
    let co2Rate = 0;
    try {
      const grid = await fetchGridCarbon();
      carbonIntensity = Number(grid.intensity || 0);
      co2Rate = ((parseFloat(totalPower) * carbonIntensity) / 1000).toFixed(1);
      sessionCO2 += parseFloat(co2Rate) * (10 / 3600);
    } catch (_) {}

    pushStateToBackend(carbonIntensity, co2Rate, totalPower, heavyCount);

    const stats = { heavyCount, totalPower, carbonIntensity, co2Rate };
    const now = Date.now();
    const cooldownPassed = overlayLastShown === null || (now - overlayLastShown) > OVERLAY_COOLDOWN_MS;

    if (heavyCount > 3 && !overlaySuppressed && cooldownPassed) {
      overlayLastShown = Date.now();
      chrome.tabs.query({ active: true, currentWindow: true }, (activeTabs) => {
        if (!activeTabs || activeTabs.length === 0) return;
        injectOverlay(activeTabs[0].id, stats);
      });
    }

    if (heavyCount > 3) {
      chrome.notifications.create(`alert-${tabId}-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/globe.png',
        title: '🌍 EcoSync — Heavy Tab Alert',
        message: `${heavyCount} heavy tabs open • ${totalPower}W • ${co2Rate}g CO₂/hr`,
        priority: 2
      });
    }

    chrome.alarms.create(`heavy-tab-${tabId}`, { delayInMinutes: HEAVY_THRESHOLD_MINS });
  });
});

function injectOverlay(tabId, stats) {
  chrome.scripting.executeScript({
    target: { tabId },
    func: (s) => {
      if (document.getElementById('tab-auditor-overlay')) return;

      const overlay = document.createElement('div');
      overlay.id = 'tab-auditor-overlay';
      overlay.style.cssText = `
        position:fixed;top:20px;right:20px;z-index:2147483647;
        background:#0f1117ee;color:#fff;border-radius:14px;
        padding:16px 20px;font-family:'Segoe UI',sans-serif;font-size:13px;
        box-shadow:0 4px 24px #00000088;border:1px solid #ffffff18;
        min-width:230px;opacity:0;transition:opacity 0.4s ease;
        backdrop-filter:blur(8px);
      `;
      overlay.innerHTML = `
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
          <span style="font-size:18px;">🌍</span>
          <span style="font-weight:700;font-size:15px;">EcoSync Alert</span>
        </div>
        <div style="color:#ff8a80;font-size:12px;margin-bottom:10px;">
          ⚠️ Heavy tab open for 10+ minutes
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
          <div style="background:#ffffff0d;border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:18px;font-weight:700;color:#e53935;">${s.heavyCount}</div>
            <div style="font-size:10px;color:#aaa;">Heavy Tabs</div>
          </div>
          <div style="background:#ffffff0d;border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:18px;font-weight:700;color:#fff;">${s.totalPower}W</div>
            <div style="font-size:10px;color:#aaa;">Est. Power</div>
          </div>
          <div style="background:#ffffff0d;border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:18px;font-weight:700;color:#fff;">${s.carbonIntensity}</div>
            <div style="font-size:10px;color:#aaa;">gCO₂/kWh</div>
          </div>
          <div style="background:#ffffff0d;border-radius:8px;padding:8px;text-align:center;">
            <div style="font-size:18px;font-weight:700;color:#f9a825;">${s.co2Rate}g</div>
            <div style="font-size:10px;color:#aaa;">CO₂/hr</div>
          </div>
        </div>
        <div style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;">
          <button id="ta-dismiss" style="
            background:#ffffff15;border:none;color:#aaa;font-size:11px;
            padding:5px 10px;border-radius:6px;cursor:pointer;">✕ Dismiss</button>
          <button id="ta-suppress" style="
            background:#ffffff15;border:none;color:#aaa;font-size:11px;
            padding:5px 10px;border-radius:6px;cursor:pointer;">🔕 Don't show again</button>
        </div>
      `;
      document.body.appendChild(overlay);

      document.getElementById('ta-dismiss').onclick = () => overlay.remove();
      document.getElementById('ta-suppress').onclick = () => {
        overlay.remove();
        chrome.runtime.sendMessage({ action: 'suppressOverlay' });
      };

      requestAnimationFrame(() => requestAnimationFrame(() => {
        overlay.style.opacity = '1';
      }));

      setTimeout(() => {
        overlay.style.opacity = '0';
        setTimeout(() => overlay.remove(), 500);
      }, 6000);
    },
    args: [stats]
  }).catch((err) => console.warn('[EcoSync] Overlay inject failed:', err));
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'ecosync-state-push') return;

  const allTabs = Object.values(tabClassification).filter(Boolean);
  const heavyCount = allTabs.filter((t) => t.weight === 'heavy' || t.weight === 'heavy-video').length;
  const totalPower = allTabs.reduce((s, t) => s + t.power, 0).toFixed(1);

  let carbonIntensity = 0;
  let co2Rate = 0;
  try {
    const grid = await fetchGridCarbon(true);
    carbonIntensity = Number(grid.intensity || 0);
    co2Rate = ((parseFloat(totalPower) * carbonIntensity) / 1000).toFixed(1);
    sessionCO2 += parseFloat(co2Rate) * (10 / 3600);
    downloadsState.gridState = grid.gridState || setGridStateFromIntensity(carbonIntensity);
  } catch (_) {}

  pushStateToBackend(carbonIntensity, co2Rate, totalPower, heavyCount);
  await refreshDownloadStoreFromChrome();
});

chrome.runtime.onInstalled.addListener(() => {
  refreshDownloadStoreFromChrome();
  ensureCommandPolling();
});

chrome.runtime.onStartup.addListener(() => {
  refreshDownloadStoreFromChrome();
  ensureCommandPolling();
});

ensureCommandPolling();