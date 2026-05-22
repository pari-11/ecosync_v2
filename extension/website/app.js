const API = 'http://localhost:8000';
const GAUGE_ARC = 283;
const OPTIMAL_THRESHOLD = 100;
const SOFT_RED_THRESHOLD = 50;

let tabRefreshTimer = null;
let downloadsRefreshTimer = null;
let simulating = false;
let currentCarbon = { intensity: 0, trafficLight: 'unknown', zone: 'in' };
let currentState = { tabs: [], sessionCO2: 0 };
let currentDownloadsState = {
  gridState: 'unknown',
  active: [],
  queued: [],
  ledger: [],
  savedCO2: 0,
  overdrafts: 0
};

function navigate(page) {
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.page === page);
  });

  document.querySelectorAll('.page').forEach((el) => {
    el.classList.toggle('active', el.id === `page-${page}`);
  });

  clearInterval(tabRefreshTimer);
  clearInterval(downloadsRefreshTimer);
  tabRefreshTimer = null;
  downloadsRefreshTimer = null;

  if (page === 'home' || page === 'dashboard') loadDashboard();

  if (page === 'tab-auditor') {
    loadTabs();
    tabRefreshTimer = setInterval(loadTabs, 15000);
  }

  if (page === 'downloads') {
    loadDownloads();
    downloadsRefreshTimer = setInterval(loadDownloads, 1000);
  }
}

function setText(id, val) {
  const el = document.getElementById(id);
  if (el) el.textContent = val;
}

function tlEmoji(tl) {
  return tl === 'red' ? '🔴' : tl === 'yellow' ? '🟡' : tl === 'green' ? '🟢' : '⚪';
}

function tlLabel(tl) {
  return tl === 'red' ? 'GRID IS DIRTY' : tl === 'yellow' ? 'GRID IS MODERATE' : tl === 'green' ? 'GRID IS CLEAN' : 'UNKNOWN';
}

function pillHTML(tl) {
  const cls = tl === 'red' ? 'pill-red' : tl === 'yellow' ? 'pill-yellow' : tl === 'green' ? 'pill-green' : 'pill-blue';
  return `<span class="pill ${cls}">${tlEmoji(tl)} ${tlLabel(tl)}</span>`;
}

function formatTime() {
  return new Date().toLocaleTimeString();
}

function formatWatts(num) {
  return `${Number(num || 0).toFixed(1)}W`;
}

function formatCO2(num) {
  return `${Number(num || 0).toFixed(2)}g`;
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

function escapeHTML(str = '') {
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function isTabBackground(tab) {
  return !tab.active || !!tab.background;
}

function isHeavyTab(tab) {
  return tab.weight === 'heavy' || tab.weight === 'heavy-video';
}

function getTabPower(tab) {
  return Number(tab.power || 0);
}

function faviconFor(tab) {
  return tab.favIconUrl || tab.favicon || ('https://www.google.com/s2/favicons?sz=64&domain_url=' + encodeURIComponent(tab.url || ''));
}

async function fetchCarbon() {
  const res = await fetch(`${API}/api/carbon/live/in`);
  if (!res.ok) throw new Error(`Carbon API error: ${res.status}`);
  return await res.json();
}

async function fetchState() {
  try {
    const res = await fetch(`${API}/api/state`);
    if (!res.ok) throw new Error(`State API error: ${res.status}`);
    return await res.json();
  } catch (_) {
    return {
      tabs: [],
      sessionCO2: 0,
      heavyCount: 0,
      totalPower: 0,
      co2Rate: 0,
      pollingRequests60s: 0,
      zombieCO2: 0
    };
  }
}

async function fetchDownloadsState() {
  try {
    const res = await fetch(`${API}/api/downloads/state`);
    if (!res.ok) throw new Error(`Downloads API error: ${res.status}`);
    return await res.json();
  } catch (_) {
    return {
      gridState: 'unknown',
      active: [],
      queued: [],
      ledger: [],
      savedCO2: 0,
      overdrafts: 0
    };
  }
}

function showFeedback(message, good = true) {
  const el = document.getElementById('bulk-action-feedback');
  if (!el) return;
  el.textContent = message;
  el.style.color = good ? 'var(--green)' : 'var(--red)';
}

function toggleSimulate() {
  simulating = !simulating;
  const btn = document.getElementById('sim-btn');

  if (btn) {
    if (simulating) {
      btn.innerHTML = '⏹ Return to Normal';
      btn.style.background = 'var(--green-bg)';
      btn.style.borderColor = '#bbf7d0';
      btn.style.color = 'var(--green)';
    } else {
      btn.innerHTML = '🟢 Simulate Green Window';
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '';
    }
  }

  loadDashboard();
  if (document.getElementById('page-tab-auditor')?.classList.contains('active')) {
    loadTabs();
  }
  if (document.getElementById('page-downloads')?.classList.contains('active')) {
    loadDownloads();
  }
}

async function loadDashboard() {
  const spin = document.getElementById('dash-spin');
  if (spin) spin.classList.add('spinning');

  try {
    let [carbon, state] = await Promise.all([fetchCarbon(), fetchState()]);

    if (simulating) {
      carbon = { intensity: 87, trafficLight: 'green', zone: 'in' };
    }

    currentCarbon = carbon;
    currentState = state;

    const tabs = state.tabs || [];
    const sessionCO2 = Number(state.sessionCO2 || 0);

    const heavy = tabs.filter((t) => isHeavyTab(t));
    const dynamic = tabs.filter((t) => t.weight === 'dynamic');
    const statik = tabs.filter((t) => t.weight === 'static');

    const totalPowerNum = tabs.reduce((sum, t) => sum + getTabPower(t), 0);
    const totalPower = totalPowerNum.toFixed(1);
    const co2Rate = ((totalPowerNum * (Number(carbon.intensity) || 0)) / 1000).toFixed(2);
    const now = formatTime();

    const tlCircle = document.getElementById('dash-tl-circle');
    if (tlCircle) {
      tlCircle.className = `tl-circle tl-${carbon.trafficLight || 'unknown'}`;
      tlCircle.textContent = tlEmoji(carbon.trafficLight);
    }

    setText('dash-intensity', simulating ? '87 (simulated)' : (carbon.intensity ?? '--'));

    const pillEl = document.getElementById('dash-pill');
    if (pillEl) pillEl.innerHTML = pillHTML(carbon.trafficLight);

    setText('dash-heavy', heavy.length);
    setText('dash-dynamic', dynamic.length);
    setText('dash-static', statik.length);
    setText('dash-power', totalPower);
    setText('dash-co2', co2Rate);
    setText('dash-session', sessionCO2.toFixed(4));
    setText('last-updated', simulating ? '🟢 Simulating clean grid' : `Last updated: ${now}`);

    setText('home-intensity', simulating ? '87' : (carbon.intensity ?? '--'));
    setText('home-timestamp', now);

    const homeTLPill = document.getElementById('home-tl-pill');
    if (homeTLPill) homeTLPill.innerHTML = pillHTML(carbon.trafficLight);

    setText('home-power', totalPower);
    setText('home-co2', co2Rate);
    setText('home-session-co2', sessionCO2.toFixed(4));
    setText('home-heavy', heavy.length);
    setText('home-dynamic', dynamic.length);
    setText('home-static', statik.length);
  } catch (e) {
    setText('dash-intensity', 'Offline');
    setText('home-intensity', 'Offline');
    console.error(e);
  } finally {
    if (spin) spin.classList.remove('spinning');
  }
}

function updateGauge(totalPower, trafficLight) {
  const gauge = document.getElementById('gauge-progress');
  const gaugeText = document.getElementById('gauge-power');
  if (!gauge || !gaugeText) return;

  const pct = Math.max(0, Math.min(totalPower / OPTIMAL_THRESHOLD, 1));
  const offset = GAUGE_ARC * (1 - pct);

  gauge.style.strokeDashoffset = String(offset);
  gauge.classList.remove('green', 'yellow', 'red');

  const cls = trafficLight === 'red' ? 'red' : totalPower > 35 ? 'yellow' : 'green';
  gauge.classList.add(cls);
  gaugeText.textContent = `${totalPower.toFixed(1)}W`;
}

function updateAuditorHub(state, carbon) {
  const tabs = state.tabs || [];
  const totalPower = tabs.reduce((sum, t) => sum + getTabPower(t), 0);

  const activeLoad = tabs
    .filter((t) => t.active)
    .reduce((sum, t) => sum + Number(t.power || 0), 0);

  const backgroundLoad = Math.max(0, totalPower - activeLoad);
  const redOverSoftCeiling = carbon.trafficLight === 'red' && totalPower > SOFT_RED_THRESHOLD;

  updateGauge(totalPower, carbon.trafficLight);
  setText('active-tab-load', formatWatts(activeLoad));
  setText('background-tab-load', formatWatts(backgroundLoad));
  setText('soft-ceiling-status', redOverSoftCeiling ? 'Alert' : 'Stable');

  const chip = document.getElementById('auditor-grid-chip');
  if (chip) {
    chip.className = `auditor-state-chip ${carbon.trafficLight || ''}`;
    chip.textContent = `Grid: ${tlEmoji(carbon.trafficLight)} ${tlLabel(carbon.trafficLight)}`;
  }

  const hub = document.getElementById('auditor-metrics-hub');
  const shell = document.getElementById('tab-auditor-shell');
  if (hub) hub.classList.toggle('alert-pulse', redOverSoftCeiling);
  if (shell) shell.classList.toggle('alert-pulse', redOverSoftCeiling);
}

function updateTelemetry(state) {
  const tabs = state.tabs || [];
  const oldBackgroundTabs = tabs.filter((t) => isTabBackground(t) && Number(t.lastFocusedMinutes ?? t.inactiveMinutes ?? 0) > 15).length;
  const pollingOffenders = tabs.filter((t) => Number(t.pollingRequests || 0) > 0 || t.weight === 'dynamic').length;
  const heavyRuntime = tabs.filter((t) => isHeavyTab(t)).length;

  const zombieCO2 =
    Number(state.zombieCO2 || 0) ||
    tabs
      .filter((t) => isTabBackground(t))
      .reduce((sum, t) => sum + ((getTabPower(t) * Number(currentCarbon.intensity || 0)) / 1000) / 4, 0);

  setText('polling-tracker', Number(state.pollingRequests60s || pollingOffenders).toString());
  setText('zombie-accumulator', formatCO2(zombieCO2));
  setText('diag-old-bg-tabs', oldBackgroundTabs);
  setText('diag-poll-offenders', pollingOffenders);
  setText('diag-heavy-runtime', heavyRuntime);
}

function renderTabsTable(state) {
  const tabs = state.tabs || [];
  const tbody = document.getElementById('tab-tbody');
  if (!tbody) return;

  if (!tabs.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align:center;padding:40px;color:var(--muted);">
          No tab data yet — the extension pushes data every 10s. Wait a moment and refresh.
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = tabs
    .map((tab) => {
      const isHeavy = isHeavyTab(tab);
      const rowClass = isHeavy
        ? 'tab-row-heavy'
        : tab.weight === 'dynamic'
          ? 'tab-row-dynamic'
          : 'tab-row-static';

      const badgeCls = isHeavy
        ? 'badge-heavy'
        : tab.weight === 'dynamic'
          ? 'badge-dynamic'
          : 'badge-static';

      const label = tab.weight === 'heavy-video' ? 'HEAVY' : String(tab.weight || 'static').toUpperCase();
      const rawTitle = tab.title || tab.url || 'Untitled Tab';
      const displayTitle = rawTitle.length > 65 ? `${rawTitle.slice(0, 65)}…` : rawTitle;
      const host = hostnameOf(tab.url);
      const power = getTabPower(tab);
      const powerClass = power >= 8 ? 'high' : power >= 2 ? 'mid' : 'low';

      return `
        <tr class="${rowClass}">
          <td style="padding-left:20px;">
            <div class="tab-identity">
              <img class="tab-favicon" src="${escapeHTML(faviconFor(tab))}" alt="" />
              <div class="tab-identity-text">
                <div class="tab-title">${escapeHTML(displayTitle)}</div>
                <div class="tab-url">${escapeHTML(host || tab.url || '')}</div>
                ${isTabBackground(tab) ? `<span class="bg-badge">Background</span>` : ''}
              </div>
            </div>
          </td>
          <td><span class="badge ${badgeCls}">${label}</span></td>
          <td><span class="power-reading ${powerClass}">${power.toFixed(1)} W</span></td>
        </tr>
      `;
    })
    .join('');
}

function renderMiniStats(state) {
  const tabs = state.tabs || [];
  const heavy = tabs.filter((t) => isHeavyTab(t));
  const dynamic = tabs.filter((t) => t.weight === 'dynamic');
  const statik = tabs.filter((t) => t.weight === 'static');
  const totalPower = tabs.reduce((sum, t) => sum + getTabPower(t), 0);

  setText('dash-heavy', heavy.length);
  setText('dash-dynamic', dynamic.length);
  setText('dash-static', statik.length);
  setText('dash-power', totalPower.toFixed(1));
}

function renderAllFromCurrentState() {
  renderMiniStats(currentState);
  renderTabsTable(currentState);
  updateAuditorHub(currentState, currentCarbon);
  updateTelemetry(currentState);
  setText('tab-last-updated', `Auto-refreshes every 15s · Last updated: ${formatTime()}`);
}

async function loadTabs() {
  const spin = document.getElementById('tab-spin');
  if (spin) spin.classList.add('spinning');

  try {
    let carbon = currentCarbon;
    if (!carbon || !carbon.intensity) {
      carbon = await fetchCarbon();
      if (simulating) carbon = { intensity: 87, trafficLight: 'green', zone: 'in' };
      currentCarbon = carbon;
    }

    const state = await fetchState();
    currentState = state;

    renderAllFromCurrentState();
  } catch (e) {
    console.error(e);
  } finally {
    if (spin) spin.classList.remove('spinning');
  }
}

function toggleDark() {
  const isDark = document.body.classList.toggle('dark');
  const btn = document.getElementById('dark-toggle');
  if (btn) btn.textContent = isDark ? '☀️ Light' : '🌙 Dark';

  try {
    localStorage.setItem('ecosync-theme', isDark ? 'dark' : 'light');
  } catch (_) {}
}

async function loadDownloads() {
  const sync = document.getElementById('downloads-live-sync');
  if (sync) sync.textContent = 'Syncing';

  try {
    const state = await fetchDownloadsState();
    if (simulating) {
      state.gridState = 'green';
    }
    currentDownloadsState = state;
    renderDownloads(state);
    if (sync) sync.textContent = 'Live';
  } catch (e) {
    console.error(e);
    renderDownloads(currentDownloadsState);
    if (sync) sync.textContent = 'Offline';
  }
}

function renderDownloads(state) {
  const active = state.active || [];
  const queued = state.queued || [];
  const ledger = state.ledger || [];
  const savedCO2 = Number(state.savedCO2 || 0);
  const overdrafts = Number(state.overdrafts || 0);

  setText('downloads-active-count', active.length);
  setText('downloads-queued-count', queued.length);
  setText('downloads-saved-total', `${savedCO2.toFixed(0)}g`);
  setText('downloads-override-total', overdrafts);
  setText('ledger-saved', `${savedCO2.toFixed(0)}g CO₂ Prevented`);
  setText('ledger-overdrafts', overdrafts);
  setText('downloads-grid-state', `Grid: ${String(state.gridState || 'unknown').toUpperCase()}`);

  const statePill = document.getElementById('downloads-grid-state');
  if (statePill) {
    statePill.className = 'downloads-status-pill';
    if (state.gridState === 'red') statePill.classList.add('red');
    else if (state.gridState === 'green') statePill.classList.add('green');
    else if (state.gridState === 'yellow') statePill.classList.add('yellow');
  }

  renderDownloadList('downloads-active-list', active, false);
  renderDownloadList('downloads-queue-list', queued, true);
  renderLedger(ledger);

  const alert = document.getElementById('downloads-dirty-alert');
  if (alert) alert.style.display = state.gridState === 'red' ? 'flex' : 'none';
}

function renderDownloadList(containerId, items, queued) {
  const root = document.getElementById(containerId);
  if (!root) return;

  if (!items.length) {
    root.innerHTML = `
      <div class="download-empty">
        ${queued ? 'No deferred downloads in the eco queue.' : 'No active downloads right now.'}
      </div>
    `;
    return;
  }

  root.innerHTML = items.map((item) => {
    const pct = Number(item.progress || 0);
    const progressStyle = `width:${Math.max(0, Math.min(pct, 100))}%`;
    const stateClass = item.gridState === 'red' ? 'red' : item.gridState === 'yellow' ? 'yellow' : 'green';
    const carbon = Number(item.carbonCost || 0);
    const overrideLabel = `Run Now (Adds ${carbon >= 1000 ? (carbon / 1000).toFixed(1) + 'kg' : carbon.toFixed(0) + 'g'} CO₂ to your Direct Footprint)`;

    return `
      <article class="download-card ${stateClass} ${queued ? 'moved' : ''} ${item.gridState === 'red' ? 'dirty' : ''}" data-id="${escapeHTML(String(item.id))}">
        <div class="download-warning-banner">
          The electricity grid is currently under heavy stress. Running this download right now will generate avoidable carbon emissions.
        </div>

        <div class="download-card-head">
          <div>
            <div class="download-title">${escapeHTML(item.fileName || 'Unknown File')}</div>
            <div class="download-meta">
              <span>${escapeHTML(item.fileSizeLabel || '--')}</span>
              <span>•</span>
              <span>${escapeHTML(item.speedLabel || '--')}</span>
              <span>•</span>
              <span>${escapeHTML(item.etaLabel || '--')}</span>
            </div>
            <div class="download-chip">Carbon ticker: <span class="download-carbon-ticker">${escapeHTML(item.carbonTicker || '0g CO₂')}</span></div>
          </div>
          <div class="pill ${stateClass === 'red' ? 'pill-red' : stateClass === 'yellow' ? 'pill-yellow' : 'pill-green'}">${escapeHTML(String(item.status || 'in progress').toUpperCase())}</div>
        </div>

        <div class="download-progress-wrap">
          <div class="download-progress-track">
            <div class="download-progress-bar" style="${progressStyle}"></div>
          </div>
        </div>

        <div class="download-metrics-row">
          <div class="download-metric">
            <div class="download-metric-label">Progress</div>
            <div class="download-metric-value">${pct.toFixed(0)}%</div>
          </div>
          <div class="download-metric">
            <div class="download-metric-label">Speed</div>
            <div class="download-metric-value">${escapeHTML(item.speedLabel || '--')}</div>
          </div>
          <div class="download-metric">
            <div class="download-metric-label">ETA</div>
            <div class="download-metric-value">${escapeHTML(item.etaLabel || '--')}</div>
          </div>
        </div>

        <div class="download-carbon">
          <span>Live carbon cost</span>
          <strong>${escapeHTML(item.carbonTicker || '0g CO₂')}</strong>
        </div>

        <div class="download-actions">
          <button class="download-btn pause" onclick="downloadAction('pause', ${item.id})">Pause &amp; Defer to Green Window</button>
          <div class="download-action-row">
            <input class="download-input" type="time" value="${escapeHTML(item.deadlineTime || '')}" onchange="downloadDeadlineChange(${item.id}, this.value)" aria-label="Deadline time for ${escapeHTML(item.fileName || 'download')}" />
            <button class="download-btn queue" onclick="downloadAction('deadline', ${item.id})">Deadline-Aware Queue</button>
          </div>
          <button class="download-btn override" onclick="downloadAction('override', ${item.id})">${overrideLabel}</button>
        </div>
      </article>
    `;
  }).join('');
}

function renderLedger(entries) {
  const tbody = document.getElementById('ledger-table');
  if (!tbody) return;

  if (!entries.length) {
    tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;padding:24px;color:var(--muted);">No entries yet.</td></tr>`;
    return;
  }

  tbody.innerHTML = entries.map((entry) => `
    <tr>
      <td>${escapeHTML(entry.date || '--')}</td>
      <td>${escapeHTML(entry.fileName || '--')}</td>
      <td>${escapeHTML(entry.action || '--')}</td>
      <td>${escapeHTML(entry.carbon || '--')}</td>
    </tr>
  `).join('');
}

async function downloadAction(action, id) {
  try {
    const res = await fetch(`${API}/api/downloads/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, id, deadline: action === 'deadline' ? document.querySelector(`[data-id="${id}"] .download-input`)?.value || '' : '' })
    });
    if (!res.ok) throw new Error('Action failed');
    await loadDownloads();
  } catch (e) {
    console.error(e);
  }
}

async function downloadDeadlineChange(id, deadline) {
  try {
    await fetch(`${API}/api/downloads/deadline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, deadline })
    });
    await loadDownloads();
  } catch (e) {
    console.error(e);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  try {
    if (localStorage.getItem('ecosync-theme') === 'dark') {
      document.body.classList.add('dark');
      const btn = document.getElementById('dark-toggle');
      if (btn) btn.textContent = '☀️ Light';
    }
  } catch (_) {}

  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', () => navigate(el.dataset.page));
  });

  loadDashboard();
});