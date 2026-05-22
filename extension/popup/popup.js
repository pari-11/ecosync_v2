const API_BASE = 'http://localhost:8000';

function classifyTab(tab) {
  if (!tab || !tab.url) return null;
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
    url.includes('discord.com') || url.includes('mail.google.com') ||
    url.includes('teams.microsoft.com') || url.includes('whatsapp.web')
  ) {
    weight = 'dynamic';
  } else if (
    url.includes('docs.google.com') || url.includes('stackoverflow.com') ||
    url.includes('wikipedia.org') || url.includes('github.com') ||
    url.includes('notion.so') || url.includes('medium.com')
  ) {
    weight = 'static';
  }

  const powerMap = { static: 0.5, dynamic: 5, heavy: 10, 'heavy-video': 15 };
  return {
    id: tab.id,
    title: tab.title || tab.url,
    url: tab.url,
    weight,
    audible: isAudible,
    power: powerMap[weight] || 0.5
  };
}

function dotClass(weight) {
  if (weight === 'heavy' || weight === 'heavy-video') return 'dot-red';
  if (weight === 'dynamic') return 'dot-yellow';
  return 'dot-green';
}
function badgeClass(weight) {
  if (weight === 'heavy' || weight === 'heavy-video') return 'badge-heavy';
  if (weight === 'dynamic') return 'badge-dynamic';
  return 'badge-static';
}
function badgeLabel(weight) {
  if (weight === 'heavy-video') return 'HEAVY+AUD';
  return weight.toUpperCase();
}

async function load() {
  try {
    // 1. Fetch live carbon data
    const res = await fetch(`${API_BASE}/api/carbon/live/in`);
    const carbon = await res.json();

    // 2. Traffic light
    const light = document.getElementById('traffic-light');
    light.className = `light ${carbon.trafficLight}`;
    document.getElementById('grid-label').textContent =
      carbon.trafficLight === 'red'    ? '🔴 GRID IS DIRTY' :
      carbon.trafficLight === 'yellow' ? '🟡 GRID IS MODERATE' :
                                         '🟢 GRID IS CLEAN';
    document.getElementById('intensity').textContent = carbon.intensity;

    // 3. Classify all open tabs
    chrome.tabs.query({}, (tabs) => {
      const classified = tabs.map(classifyTab).filter(Boolean);

      const heavyTabs   = classified.filter(t => t.weight === 'heavy' || t.weight === 'heavy-video');
      const dynamicTabs = classified.filter(t => t.weight === 'dynamic');
      const staticTabs  = classified.filter(t => t.weight === 'static');

      // 4. Update counts
      document.getElementById('heavy-count').textContent   = heavyTabs.length;
      document.getElementById('dynamic-count').textContent = dynamicTabs.length;
      document.getElementById('static-count').textContent  = staticTabs.length;

      // 5. Total power + CO2 rate
      const totalPower = classified.reduce((sum, t) => sum + t.power, 0);
      const co2Rate    = ((totalPower * carbon.intensity) / 1000).toFixed(1);

      document.getElementById('total-power').textContent = totalPower.toFixed(1);
      document.getElementById('co2-rate').textContent    = co2Rate;

      // 6. Alert banner
      const alertBanner = document.getElementById('alert-banner');
      const alertMsg    = document.getElementById('alert-msg');
      if (carbon.trafficLight === 'red' && heavyTabs.length > 0) {
        const co2Saved = ((heavyTabs.reduce((s, t) => s + t.power, 0) * carbon.intensity) / 1000).toFixed(1);
        alertMsg.textContent = `⚠️ Suspend ${heavyTabs.length} heavy tab(s) to save ~${co2Saved}g CO₂/hr`;
        alertBanner.classList.remove('hidden');
      } else {
        alertBanner.classList.add('hidden');
      }

      // 7. Tab breakdown list (ALL tabs)
      const list = document.getElementById('tabs-list');
      list.innerHTML = '';
      classified.forEach(tab => {
        const row = document.createElement('div');
        row.className = 'tab-row';
        row.innerHTML = `
          <div class="tab-dot ${dotClass(tab.weight)}"></div>
          <div class="tab-name" title="${tab.title}">${tab.title}</div>
          <div class="tab-power">${tab.power}W</div>
          <div class="tab-badge ${badgeClass(tab.weight)}">${badgeLabel(tab.weight)}</div>
        `;
        list.appendChild(row);
      });

      // 8. Suspend All Heavy button
      const closeHeavyBtn = document.getElementById('close-heavy-btn');
      if (heavyTabs.length > 0) {
        closeHeavyBtn.classList.remove('hidden');
        closeHeavyBtn.onclick = () => {
          heavyTabs.forEach(t => chrome.tabs.remove(t.id));
          setTimeout(load, 500);
        };
      } else {
        closeHeavyBtn.classList.add('hidden');
      }
    });

  } catch (err) {
    document.getElementById('grid-label').textContent = 'Backend offline';
    document.getElementById('intensity').textContent  = '--';
    document.getElementById('total-power').textContent = '--';
    document.getElementById('co2-rate').textContent    = '--';
    console.error(err);
  }
}

document.getElementById('refresh-btn').addEventListener('click', load);
load();

chrome.runtime.sendMessage({ action: 'getSessionCO2' }, (res) => {
  if (res) {
    document.getElementById('session-co2').textContent = res.total.toFixed(4) + 'g';
  }
});

