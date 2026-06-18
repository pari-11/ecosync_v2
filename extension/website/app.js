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
  current: null,
  deferred: [],
  ledger: [],
  savedCO2: 0,
  cancelledCount: 0
};

let carbonTrendChart = null;

const equivalencyMessages = [
  'Your session savings today are equivalent to charging a smartphone 12 times.',
  'Today’s optimized usage avoided enough CO₂ to power an LED bulb for 18 hours.',
  'Your eco-aware scheduling today is roughly equal to planting 24 square centimeters of forest.',
  'Your deferred downloads today prevented emissions equal to 3 hours of HD video streaming.'
];

// Eco-scheduler state
let ecoTasks = [];
let selectedTagSet = new Set();

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
    downloadsRefreshTimer = setInterval(loadDownloads, 10000);
  }

  if (page === 'eco-scheduler') {
    loadEcoScheduler();
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
  return tl === 'red'
    ? 'GRID IS DIRTY'
    : tl === 'yellow'
      ? 'GRID IS MODERATE'
      : tl === 'green'
        ? 'GRID IS CLEAN'
        : 'UNKNOWN';
}

function pillHTML(tl) {
  const cls = tl === 'red'
    ? 'pill-red'
    : tl === 'yellow'
      ? 'pill-yellow'
      : tl === 'green'
        ? 'pill-green'
        : 'pill-blue';
  return `<span class="pill ${cls}">${tlEmoji(tl)} ${tlLabel(tl)}</span>`;
}

function formatTime() {
  return new Date().toLocaleTimeString();
}

function formatWatts(num) {
  return `${Number(num || 0).toFixed(1)}W`;
}

function formatCO2(num) {
  const value = Number(num || 0);
  return value >= 1000 ? `${(value / 1000).toFixed(2)}kg CO₂` : `${value.toFixed(2)}g CO₂`;
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
      current: null,
      deferred: [],
      ledger: [],
      savedCO2: 0,
      cancelledCount: 0
    };
  }
}

async function fetchCarbonHistory() {
  try {
    const res = await fetch(`${API}/api/carbon/history`);

    if (!res.ok) {
      throw new Error(`History API error: ${res.status}`);
    }

    return await res.json();
  } catch (e) {
    console.error(e);
    return { points: [] };
  }
}

async function fetchPowerBreakdown() {
  try {
    const res = await fetch(`${API}/api/carbon/power-breakdown`);

    if (!res.ok) {
      throw new Error(`Breakdown API error: ${res.status}`);
    }

    return await res.json();
  } catch (e) {
    console.error(e);
    return { sources: [] };
  }
}

// Eco-scheduler API helpers
async function fetchEcoTasks() {
  const res = await fetch(`${API}/api/scheduler/tasks`);
  if (!res.ok) throw new Error(`Scheduler API error: ${res.status}`);
  return await res.json();
}

async function createEcoTask(payload) {
  const res = await fetch(`${API}/api/scheduler/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Create task API error: ${res.status}`);
  return await res.json();
}

async function updateTaskStatus(taskId, status) {
  const res = await fetch(`${API}/api/scheduler/tasks/${taskId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (!res.ok) throw new Error(`Update task API error: ${res.status}`);
  return await res.json();
}

async function deleteTask(taskId) {
  const res = await fetch(`${API}/api/scheduler/tasks/${taskId}`, {
    method: 'DELETE'
  });
  if (!res.ok) throw new Error(`Delete task API error: ${res.status}`);
}

async function clearAllTasks() {
  if (!confirm('Clear all tasks from the Eco-Scheduler?')) return;
  try {
    await fetch(`${API}/api/scheduler/tasks`, { method: 'DELETE' });
    ecoTasks = [];
    renderEcoBoard();
    updateEcoHomeSummary();
  } catch (e) {
    console.error(e);
  }
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
  if (document.getElementById('page-tab-auditor')?.classList.contains('active')) loadTabs();
  if (document.getElementById('page-downloads')?.classList.contains('active')) loadDownloads();
  if (document.getElementById('page-eco-scheduler')?.classList.contains('active')) loadEcoScheduler();
}

async function loadDashboard() {
  const spin = document.getElementById('dash-spin');
  if (spin) spin.classList.add('spinning');

  try {
    let [carbon, state] = await Promise.all([fetchCarbon(), fetchState()]);

    if (simulating) carbon = { intensity: 87, trafficLight: 'green', zone: 'in' };

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

    const currentDownload = currentDownloadsState.current;
    setText('home-download-active', currentDownload ? 1 : 0);
    setText('home-download-queue', (currentDownloadsState.deferred || []).length);
    setText('home-download-saved', `${Number(currentDownloadsState.savedCO2 || 0).toFixed(2)}g`);

    if (Array.isArray(ecoTasks) && ecoTasks.length) {
      updateEcoHomeSummary();
    }

    await renderCarbonTrendChart();
    await renderEnergyMix();
    rotateEquivalency();

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
async function renderCarbonTrendChart() {
  const chartData = await fetchCarbonHistory();

  const points = chartData.points || [];

  const ctx = document.getElementById('carbonTrendChart');

  if (!ctx || !points.length) return;

  const labels = points.map((p) => p.time);
  const values = points.map((p) => p.value);

  if (carbonTrendChart) {
    carbonTrendChart.destroy();
  }

  carbonTrendChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Carbon Intensity',
          data: values,
          tension: 0.4,
          fill: true,
          borderWidth: 3,
          pointRadius: 4,
          backgroundColor: 'rgba(34,197,94,0.12)',
          borderColor: '#22c55e'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: false
        }
      },
      scales: {
        x: {
          grid: {
            display: false
          }
        },
        y: {
          beginAtZero: false,
          title: {
            display: true,
            text: 'gCO₂/kWh'
          }
        }
      }
    }
  });
}

async function renderEnergyMix() {
  const data = await fetchPowerBreakdown();

  const root = document.getElementById('energy-mix-list');

  if (!root) return;

  const sources = data.sources || [];

  if (!sources.length) {
    root.innerHTML = `
      <div class="energy-loading">
        No source mix data available.
      </div>
    `;
    return;
  }

  root.innerHTML = sources.map((item) => `
    <div class="energy-row">
      <div class="energy-top">
        <span>${item.source}</span>
        <strong>${item.percent}%</strong>
      </div>

      <div class="energy-bar-track">
        <div
          class="energy-bar-fill"
          style="width:${item.percent}%"
        ></div>
      </div>
    </div>
  `).join('');
}

function rotateEquivalency() {
  const el = document.getElementById('equivalency-text');

  if (!el) return;

  const random =
    equivalencyMessages[
      Math.floor(Math.random() * equivalencyMessages.length)
    ];

  el.textContent = random;
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
    if (simulating) state.gridState = 'green';

    currentDownloadsState = state;
    renderDownloads(state);

    setText('home-download-active', state.current ? 1 : 0);
    setText('home-download-queue', (state.deferred || []).length);
    setText('home-download-saved', `${Number(state.savedCO2 || 0).toFixed(2)}g`);
    setText('downloads-last-updated', `Live download state · ${formatTime()}`);

    if (sync) sync.textContent = 'Live';
  } catch (e) {
    console.error(e);
    renderDownloads(currentDownloadsState);
    if (sync) sync.textContent = 'Offline';
  }
}

function renderDownloads(state) {
  const current = state.current || null;
  const deferred = state.deferred || [];
  const ledger = state.ledger || [];
  const savedCO2 = Number(state.savedCO2 || 0);
  const cancelledCount = Number(state.cancelledCount || 0);

  setText('downloads-active-count', current ? 1 : 0);
  setText('downloads-queued-count', deferred.length);
  setText('downloads-saved-total', formatCO2(savedCO2));
  setText('downloads-override-total', cancelledCount);
  setText('ledger-saved', `${formatCO2(savedCO2)} Prevented`);
  setText('ledger-overdrafts', cancelledCount);
  setText('downloads-grid-state', `Grid: ${String(state.gridState || 'unknown').toUpperCase()}`);

  const statePill = document.getElementById('downloads-grid-state');
  if (statePill) {
    statePill.className = 'downloads-status-pill';
    if (state.gridState === 'red') statePill.classList.add('red');
    else if (state.gridState === 'green') statePill.classList.add('green');
    else if (state.gridState === 'yellow') statePill.classList.add('yellow');
  }

  renderCurrentDownload(current);
  renderDeferredDownloads(deferred);
  renderLedger(ledger);

  const alert = document.getElementById('downloads-dirty-alert');
  if (alert) alert.style.display = current && state.gridState === 'red' ? 'flex' : 'none';
}

function renderCurrentDownload(item) {
  const root = document.getElementById('downloads-active-list');
  if (!root) return;

  if (!item) {
    root.innerHTML = `
      <div class="download-empty">
        No active downloads right now.
      </div>
    `;
    return;
  }

  const pct = Number(item.progress || 0);
  const progressStyle = `width:${Math.max(0, Math.min(pct, 100))}%`;
  const stateClass = item.gridState === 'red' ? 'red' : item.gridState === 'yellow' ? 'yellow' : 'green';

  root.innerHTML = `
    <article class="download-card ${stateClass} ${item.gridState === 'red' ? 'dirty' : ''}" data-id="${escapeHTML(String(item.id))}">
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
          <div class="download-chip">Current CO₂ used: <span class="download-carbon-ticker">${escapeHTML(item.carbonTicker || '0.00g CO₂')}</span></div>
        </div>
        <div class="pill ${stateClass === 'red' ? 'pill-red' : stateClass === 'yellow' ? 'pill-yellow' : 'pill-green'}">${escapeHTML(String(item.status || 'downloading').toUpperCase())}</div>
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
        <span>Live carbon cost so far</span>
        <strong>${escapeHTML(item.carbonTicker || '0.00g CO₂')}</strong>
      </div>

      <div class="download-actions">
        <button class="download-btn queue" onclick="downloadAction('defer', ${item.id})">Defer to Green Window</button>
        <button class="download-btn pause" onclick="downloadAction('pause', ${item.id})">Pause</button>
        <button class="download-btn override" onclick="downloadAction('cancel', ${item.id})">Cancel</button>
      </div>
    </article>
  `;
}

function renderDeferredDownloads(items) {
  const root = document.getElementById('downloads-queue-list');
  if (!root) return;

  if (!items.length) {
    root.innerHTML = `
      <div class="download-empty">
        No deferred downloads right now.
      </div>
    `;
    return;
  }

  root.innerHTML = items.map((item) => `
    <article class="download-card moved ${item.gridState === 'red' ? 'red' : item.gridState === 'yellow' ? 'yellow' : 'green'}" data-id="${escapeHTML(String(item.id))}">
      <div class="download-card-head">
        <div>
          <div class="download-title">${escapeHTML(item.fileName || 'Unknown File')}</div>
          <div class="download-meta">
            <span>${escapeHTML(item.fileSizeLabel || '--')}</span>
            <span>•</span>
            <span>Deferred</span>
          </div>
        </div>
        <div class="pill pill-green">DEFERRED</div>
      </div>

      <div class="download-carbon">
        <span>Estimated CO₂ avoided</span>
        <strong>${formatCO2(item.carbonCost || 0)}</strong>
      </div>

      <div class="download-carbon" style="margin-top:10px;">
        <span>Estimated green window</span>
        <strong>${escapeHTML(item.resumeAtLabel || 'Waiting for cleaner grid')}</strong>
      </div>

      <div class="download-meta" style="margin-top:10px;">
        This download is paused and queued for a cleaner electricity window.
      </div>

      <div class="download-actions" style="margin-top:14px;">
        <button class="download-btn pause" onclick="downloadAction('resume', ${item.id})">Resume now</button>
      </div>
    </article>
  `).join('');
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

async function downloadAction(actionType, id) {
  try {
    const res = await fetch(`${API}/api/downloads/commands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: actionType,
        download_id: Number(id)
      })
    });

    if (!res.ok) {
      throw new Error(`Command API failed: ${res.status}`);
    }

    await loadDownloads();
  } catch (e) {
    console.error(e);
  }
}

// ---------------- ECO SCHEDULER FRONTEND ----------------

function classifyTaskModeLocal(task) {
  const onlineKeywords = [
    'download', 'upload', 'sync', 'video call', 'zoom', 'meet',
    'stream', 'streaming', 'git push', 'push', 'cloud backup', 'backup',
    'watch', 'update'
  ];
  const offlineKeywords = [
    'write', 'code', 'read', 'review', 'brainstorm',
    'document', 'sketch', 'organize', 'research'
  ];

  const tags = (task.tags || []).map((t) => String(t).toLowerCase());

  if (tags.includes('online')) return 'online';
  if (tags.includes('offline')) return 'offline';

  const text = [task.title || '', task.description || '', tags.join(' ')]
    .join(' ')
    .toLowerCase();

  if (onlineKeywords.some((kw) => text.includes(kw))) return 'online';
  if (offlineKeywords.some((kw) => text.includes(kw))) return 'offline';

  return task.mode || 'offline';
}

function openTaskModal() {
  const back = document.getElementById('eco-modal');
  if (back) back.style.display = 'flex';
}

function closeTaskModal() {
  const back = document.getElementById('eco-modal');
  if (back) back.style.display = 'none';

  const form = document.getElementById('eco-task-form');
  if (form) form.reset();

  selectedTagSet.clear();
  document.querySelectorAll('.eco-tag-pill').forEach((btn) => btn.classList.remove('selected'));
}

async function submitTaskForm(ev) {
  ev.preventDefault();
  const form = document.getElementById('eco-task-form');
  if (!form) return;

  const title = form.title.value.trim();
  const description = form.description.value.trim();
  const priority = form.priority.value;
  const estimatedMinutes = form.estimated_minutes.value ? Number(form.estimated_minutes.value) : null;
  const tagsRaw = form.tags.value || '';
  const customTags = tagsRaw
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  const presetTags = Array.from(selectedTagSet);
  const tags = [...presetTags, ...customTags];

  if (!title) return;

  try {
    const newTask = await createEcoTask({
      title,
      description,
      priority,
      estimated_minutes: estimatedMinutes,
      tags
      });

      ecoTasks.push(newTask);

      closeTaskModal();

      renderEcoBoard();
  } catch (e) {
    console.error(e);
  }
}

function buildTaskBadges(task, currentTL) {
  const parts = [];

  const priorityLabel =
    task.priority === 'high'
      ? '🔴 High Priority'
      : task.priority === 'medium'
        ? '🟡 Medium Priority'
        : '🟢 Low Priority';

  parts.push(`<span class="eco-badge eco-priority">${priorityLabel}</span>`);

  const mode = classifyTaskModeLocal(task);
  if (mode === 'online') {
    parts.push('<span class="eco-badge eco-mode-online">⚡ Online Task</span>');
  } else {
    parts.push('<span class="eco-badge eco-mode-offline">🍃 Offline Task</span>');
  }

  if (task.estimated_minutes) {
    parts.push(`<span class="eco-badge eco-duration">${Number(task.estimated_minutes)} mins</span>`);
  }

  if (Array.isArray(task.tags) && task.tags.length) {
    const label = task.tags.map((t) => `#${escapeHTML(t)}`).join(' ');
    parts.push(`<span class="eco-badge eco-tags">${label}</span>`);
  }

  if (mode === 'online' && currentTL === 'red') {
    parts.push('<span class="eco-badge eco-warning">⚠️ Grid is Dirty — shift to offline or wait for your green window.</span>');
  }
  if (mode === 'offline' && currentTL === 'red') {
    parts.push('<span class="eco-badge eco-focus">Perfect time for this task — grid under stress, go local.</span>');
  }

  return parts.join('');
}

function renderEcoBoard() {
  const pendingCol = document.getElementById('eco-col-pending');
  const queueCol = document.getElementById('eco-col-queue');
  const completedCol = document.getElementById('eco-col-completed');
  if (!pendingCol || !queueCol || !completedCol) return;

  const pending = ecoTasks.filter((t) => t.status === 'pending');
  const completed = ecoTasks.filter((t) => t.status === 'completed');

  const onlinePending = pending.filter((t) => classifyTaskModeLocal(t) === 'online');

  // SJF: shortest estimated_minutes first for online tasks
  onlinePending.sort((a, b) => {
    const ea = a.estimated_minutes || Number.MAX_SAFE_INTEGER;
    const eb = b.estimated_minutes || Number.MAX_SAFE_INTEGER;
    if (ea === eb) return 0;
    return ea < eb ? -1 : 1;
  });

  setText('eco-pending-count', pending.length);
  setText('eco-queue-count', onlinePending.length);
  setText('eco-completed-count', completed.length);

  updateEcoHomeSummary();

  const tl = currentCarbon.trafficLight || 'unknown';

  if (!pending.length) {
    pendingCol.innerHTML = `
      <div class="download-empty">
        No pending tasks yet. Create one to get green window hints.
      </div>
    `;
  } else {
    pendingCol.innerHTML = pending
      .map((task) => {
        const mode = classifyTaskModeLocal(task);
        const dirtyClass = mode === 'online' && tl === 'red' ? 'eco-task-dirty' : '';
        const cardModeClass = mode === 'online' ? 'eco-task-online' : 'eco-task-offline';

        return `
          <article class="eco-task-card ${cardModeClass} ${dirtyClass}" data-id="${task.id}" data-mode="${mode}">
            <div class="eco-task-head">
              <h3>${escapeHTML(task.title)}</h3>
              <button class="eco-task-delete" type="button" onclick="handleDeleteTask(${task.id})">✕</button>
            </div>
            <p class="eco-task-desc">${escapeHTML(task.description || '')}</p>
            <div class="eco-task-badges">
              ${buildTaskBadges(task, tl)}
            </div>
            <div class="eco-task-window">
              <span class="eco-window-label">🔋 Recommended Green Window</span>
              <span class="eco-window-value">${escapeHTML(task.recommended_window || '—')}</span>
            </div>
            <div class="eco-task-footer">
              <button type="button" class="refresh-btn" onclick="handleCompleteTask(${task.id}, '${mode}')">
                Mark Complete
              </button>
            </div>
          </article>
        `;
      })
      .join('');
  }

  if (!onlinePending.length) {
    queueCol.innerHTML = `
      <div class="download-empty">
        No online tasks in the queue. Add a download/upload/render to see its green window.
      </div>
    `;
  } else {
    queueCol.innerHTML = onlinePending
      .map((task) => {
        const dirty = tl === 'red';
        const dirtyClass = dirty ? 'eco-task-dirty' : '';
        return `
          <article class="eco-task-card eco-task-online ${dirtyClass}" data-id="${task.id}" data-mode="online">
            <div class="eco-task-head">
              <h3>${escapeHTML(task.title)}</h3>
              <span class="eco-pill-inline">⚡ Online Task</span>
            </div>
            <p class="eco-task-desc">${escapeHTML(task.description || '')}</p>
            <div class="eco-task-badges">
              ${buildTaskBadges(task, tl)}
            </div>
            <div class="eco-task-window">
              <span class="eco-window-label">🔋 Recommended Green Window</span>
              <span class="eco-window-value">${escapeHTML(task.recommended_window || '—')}</span>
            </div>
            ${dirty ? `<div class="eco-nudge">⚠️ Grid is Dirty. Shift to an offline task or wait for this window.</div>` : ''}
            <div class="eco-task-footer">
              <button type="button" class="refresh-btn" onclick="handleCompleteTask(${task.id}, 'online')">
                Mark Complete
              </button>
            </div>
          </article>
        `;
      })
      .join('');
  }

  if (!completed.length) {
    completedCol.innerHTML = `
      <div class="download-empty">
        No completed tasks yet. Once you mark a task complete, it shows up here with a small carbon note.
      </div>
    `;
  } else {
    completedCol.innerHTML = completed
      .map((task) => {
        const mode = classifyTaskModeLocal(task);
        const isOnline = mode === 'online';
        const stamp = isOnline
          ? '✅ Task executed during a green window. CO₂ likely reduced vs peak execution.'
          : '✅ Offline focus task completed. Good job avoiding heavy online load.';

        return `
          <article class="eco-task-card eco-task-completed" data-id="${task.id}" data-mode="${mode}">
            <div class="eco-task-head">
              <h3>${escapeHTML(task.title)}</h3>
            </div>
            <p class="eco-task-desc">${escapeHTML(task.description || '')}</p>
            <div class="eco-task-badges">
              ${buildTaskBadges(task, tl)}
            </div>
            <div class="eco-task-window">
              <span class="eco-window-label">Execution Window</span>
              <span class="eco-window-value">${escapeHTML(task.recommended_window || '—')}</span>
            </div>
            <div class="eco-task-stamp">
              ${stamp}
            </div>
          </article>
        `;
      })
      .join('');
  }
}

function updateEcoHomeSummary() {
  const pending = ecoTasks.filter((t) => t.status === 'pending');
  const completed = ecoTasks.filter((t) => t.status === 'completed');
  const online = ecoTasks.filter((t) => classifyTaskModeLocal(t) === 'online');

  setText('home-eco-pending', pending.length);
  setText('home-eco-completed', completed.length);
  setText('home-eco-online', online.length);
}

async function handleCompleteTask(id) {
  try {
    await updateTaskStatus(id, 'completed');
    await loadEcoScheduler();
  } catch (e) {
    console.error(e);
  }
}

async function handleDeleteTask(id) {
  try {
    await deleteTask(id);
    await loadEcoScheduler();
  } catch (e) {
    console.error(e);
  }
}

async function loadEcoScheduler() {
  try {
    const tasks = await fetchEcoTasks();
    ecoTasks = tasks || [];
    renderEcoBoard();
  } catch (e) {
    console.error(e);
  }
}

// ---------------- BOOTSTRAP ----------------

window.addEventListener('DOMContentLoaded', async () => {
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

  document.querySelectorAll('.eco-tag-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      if (!tag) return;
      if (selectedTagSet.has(tag)) {
        selectedTagSet.delete(tag);
        btn.classList.remove('selected');
      } else {
        selectedTagSet.add(tag);
        btn.classList.add('selected');
      }
    });
  });

  await Promise.allSettled([loadDashboard(), loadDownloads()]);
});