'use strict';

// ─────────────────────────────────────
//  API PREDICTOR & LOCAL FALLBACKS
// ─────────────────────────────────────

// Tamil Nadu Bi-Monthly Electricity Bill Slabs calculation (used for fallback local calculation)
function calculateTamilNaduBill(u) {
  const slabsAbove500 = [
    [100, 0.0], [300, 4.70], [100, 6.30], [100, 8.40], [200, 9.45], [200, 10.50], [Infinity, 11.55]
  ];
  const slabsBelow500 = [
    [200, 0.0], [200, 4.70], [Infinity, 6.30]
  ];
  const slabs = u <= 500 ? slabsBelow500 : slabsAbove500;
  let amt = 0.0;
  let remainingUnits = u;
  for (const [limit, rate] of slabs) {
    if (remainingUnits <= 0) break;
    const unitsInSlab = Math.min(remainingUnits, limit);
    amt += unitsInSlab * rate;
    remainingUnits -= unitsInSlab;
  }
  return amt;
}

// Fallback Linear Regression forecast with Tamil Nadu bill calculation
function runLocalFallbackForecast(records) {
  if (records.length < 2) return [];
  const sorted = [...records].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const pts = sorted.slice(-6).map((r, i) => ({ x: i, y: parseFloat(r.units) || 0 }));
  const n = pts.length;
  const sumX = pts.reduce((s, p) => s + p.x, 0);
  const sumY = pts.reduce((s, p) => s + p.y, 0);
  const sumXY = pts.reduce((s, p) => s + p.x * p.y, 0);
  const sumX2 = pts.reduce((s, p) => s + p.x * p.x, 0);
  const denom = n * sumX2 - sumX * sumX;
  const slope = denom !== 0 ? (n * sumXY - sumX * sumY) / denom : 0;
  const interc = (sumY - slope * sumX) / n;

  const lastDate = parseDate(sorted[sorted.length - 1].date);

  const predictions = [1, 2].map(i => {
    const units = Math.max(0, Math.round(interc + slope * (n - 1 + i)));
    const nextDate = addMonths(lastDate, i);
    return { date: formatMonthYear(nextDate), units, predicted: true };
  });

  const u1 = predictions[0].units;
  const u2 = predictions[1].units;
  const sumUnits = u1 + u2;
  if (sumUnits > 0) {
    const totalBill = calculateTamilNaduBill(sumUnits);
    predictions[0].bill_amount = Math.round((u1 / sumUnits) * totalBill);
    predictions[1].bill_amount = Math.round((u2 / sumUnits) * totalBill);
  } else {
    predictions[0].bill_amount = 0;
    predictions[1].bill_amount = 0;
  }

  return predictions;
}

// Helper to generate a unique string hash of records for caching checks
function getRecordsHash(records) {
  const sorted = [...records].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  return sorted.map(r => `${r.date}:${r.units}:${r.occupants}:${r.bill_amount}`).join('|');
}

// Global active fetch controllers to prevent race conditions on fast switching
let activeForecastController = null;

async function triggerForecastFetch() {
  const fam = getCurrentFamily();
  if (!fam || fam.records.length === 0) {
    appState.cachedForecast = null;
    appState.cachedForecastFamilyId = null;
    appState.cachedForecastRecordsHash = null;
    renderStats();
    renderForecastChart();
    renderComparisonCharts();
    return;
  }

  const hash = getRecordsHash(fam.records);
  if (appState.cachedForecast && appState.cachedForecastFamilyId === fam.id && appState.cachedForecastRecordsHash === hash) {
    // Already matches cache, no need to load
    return;
  }

  // Cancel any in-flight requests
  if (activeForecastController) {
    activeForecastController.abort();
  }
  activeForecastController = new AbortController();
  const { signal } = activeForecastController;

  // Show loading indicators on stats cards and chart wraps
  setStatsLoading(true);

  try {
    const response = await fetch('/api/predict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ records: fam.records }),
      signal
    });

    if (!response.ok) {
      throw new Error(`API returned status ${response.status}`);
    }

    const data = await response.json();
    if (signal.aborted) return;

    appState.cachedForecast = data;
    appState.cachedForecastFamilyId = fam.id;
    appState.cachedForecastRecordsHash = hash;
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.error("API forecast fetch failed. Falling back to local regression:", e);
    // Fallback locally in case of network issues
    appState.cachedForecast = runLocalFallbackForecast(fam.records);
    appState.cachedForecastFamilyId = fam.id;
    appState.cachedForecastRecordsHash = hash;
  } finally {
    if (!signal.aborted) {
      setStatsLoading(false);
      // Refresh displays with the new forecast values
      renderStats();
      renderForecastChart();
      renderComparisonCharts();
    }
  }
}

function setStatsLoading(loading) {
  const labelUnits = document.getElementById('stat-forecast-units');
  const vsAvgSubEl = document.getElementById('stat-vs-avg-sub');
  if (loading) {
    if (labelUnits) labelUnits.textContent = '⏳ Loading...';
    if (vsAvgSubEl) vsAvgSubEl.textContent = 'fetching predictions...';
  }
}

// ─────────────────────────────────────
//  CONSTANTS & STATE
// ─────────────────────────────────────
const STORAGE_KEY_USERS = 'wc_users';
const STORAGE_KEY_SESSION = 'wc_session';
const STORAGE_KEY_DATA = 'wc_data';

const DEMO_USER = { name: 'Admin', email: 'admin@wattcast.com', password: 'password123' };

let appState = {
  currentFamilyId: null,
  families: [],
  currentTab: 'forecast',
  forecastChart: null,
  comparisonCharts: [],
  currentUser: null,
  cachedForecast: null,
  cachedForecastFamilyId: null,
  cachedForecastRecordsHash: null,
};

// ─────────────────────────────────────
//  STORAGE HELPERS
// ─────────────────────────────────────
function loadUsers() {
  const raw = localStorage.getItem(STORAGE_KEY_USERS);
  const users = raw ? JSON.parse(raw) : [];
  if (!users.find(u => u.email === DEMO_USER.email)) {
    users.push({ ...DEMO_USER, id: 'demo-user' });
    saveUsers(users);
  }
  return users;
}
function saveUsers(users) { localStorage.setItem(STORAGE_KEY_USERS, JSON.stringify(users)); }
function loadSession() { const r = localStorage.getItem(STORAGE_KEY_SESSION); return r ? JSON.parse(r) : null; }
function saveSession(u) { localStorage.setItem(STORAGE_KEY_SESSION, JSON.stringify(u)); }
function clearSession() { localStorage.removeItem(STORAGE_KEY_SESSION); }

function loadAppData(userId) {
  const raw = localStorage.getItem(`${STORAGE_KEY_DATA}_${userId}`);
  const families = raw ? JSON.parse(raw) : JSON.parse(JSON.stringify(DEMO_FAMILIES));

  // Self-heal/migrate any 2-digit years that were incorrectly parsed as 2070-2099
  families.forEach(f => {
    if (f.records) {
      f.records.forEach(r => {
        if (r.date) {
          const d = parseDate(r.date);
          if (d.getFullYear() >= 2070 && d.getFullYear() <= 2099) {
            const correctedYear = d.getFullYear() - 100;
            const correctedDate = new Date(correctedYear, d.getMonth(), 1);
            r.date = formatMMYYYY(correctedDate);
          }
        }
      });
    }
  });

  return families;
}
function saveAppData(userId, families) {
  localStorage.setItem(`${STORAGE_KEY_DATA}_${userId}`, JSON.stringify(families));
}

// ─────────────────────────────────────
//  AUTH
// ─────────────────────────────────────
function switchAuthTab(tab) {
  document.getElementById('signin-form').classList.toggle('hidden', tab !== 'signin');
  document.getElementById('signup-form').classList.toggle('hidden', tab !== 'signup');
  document.getElementById('tab-signin').classList.toggle('active', tab === 'signin');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
}

function togglePw(inputId, btn) {
  const input = document.getElementById(inputId);
  if (input.type === 'password') { input.type = 'text'; btn.textContent = '🙈'; }
  else { input.type = 'password'; btn.textContent = '👁'; }
}

function setButtonLoading(btnId, loading) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.querySelector('span').classList.toggle('hidden', loading);
  btn.querySelector('.btn-loader').classList.toggle('hidden', !loading);
  btn.disabled = loading;
}

function handleSignIn(e) {
  e.preventDefault();
  const email = document.getElementById('signin-email').value.trim();
  const password = document.getElementById('signin-password').value;
  const errEl = document.getElementById('signin-error');
  errEl.classList.add('hidden');
  setButtonLoading('signin-btn', true);

  setTimeout(() => {
    const users = loadUsers();
    const user = users.find(u => u.email === email && u.password === password);
    if (!user) {
      errEl.textContent = 'Invalid email or password.';
      errEl.classList.remove('hidden');
      setButtonLoading('signin-btn', false);
      return;
    }
    saveSession(user);
    enterDashboard(user);
  }, 600);
}

function handleSignUp(e) {
  e.preventDefault();
  const name = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  const sucEl = document.getElementById('signup-success');
  errEl.classList.add('hidden');
  sucEl.classList.add('hidden');
  setButtonLoading('signup-btn', true);

  setTimeout(() => {
    const users = loadUsers();
    if (users.find(u => u.email === email)) {
      errEl.textContent = 'Email already registered. Please sign in.';
      errEl.classList.remove('hidden');
      setButtonLoading('signup-btn', false);
      return;
    }
    const newUser = { id: 'u-' + Date.now(), name, email, password };
    users.push(newUser);
    saveUsers(users);
    saveSession(newUser);
    sucEl.textContent = 'Account created! Redirecting…';
    sucEl.classList.remove('hidden');
    setTimeout(() => enterDashboard(newUser), 700);
  }, 600);
}

function handleLogout() {
  clearSession();
  // Destroy charts
  if (appState.forecastChart) { appState.forecastChart.destroy(); appState.forecastChart = null; }
  appState.comparisonCharts.forEach(c => c.destroy());
  appState.comparisonCharts = [];

  document.getElementById('login-page').classList.add('active');
  document.getElementById('dashboard-page').classList.remove('active');
  document.getElementById('signin-form').reset();
  document.getElementById('signup-form').reset();
  document.getElementById('signin-error').classList.add('hidden');
  document.getElementById('signup-error').classList.add('hidden');
  document.getElementById('signup-success').classList.add('hidden');
  setButtonLoading('signin-btn', false);
  setButtonLoading('signup-btn', false);
  switchAuthTab('signin');
}

function enterDashboard(user) {
  document.getElementById('login-page').classList.remove('active');
  document.getElementById('dashboard-page').classList.add('active');

  const initials = user.name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
  document.getElementById('user-avatar-initials').textContent = initials;
  document.getElementById('user-display-name').textContent = user.name;

  appState.currentUser = user;
  appState.families = loadAppData(user.id);
  appState.currentFamilyId = appState.families[0]?.id || null;
  appState.currentTab = 'forecast';

  // Reset tabs visually
  switchTab('forecast');
  renderFamilyTabs();
  renderAll();
}

// ─────────────────────────────────────
//  FAMILY MANAGEMENT
// ─────────────────────────────────────
function renderFamilyTabs() {
  const container = document.getElementById('family-tabs');
  container.innerHTML = '';
  if (appState.families.length === 0) {
    container.innerHTML = '<div class="family-tabs-empty">👨\u200d👩\u200d👧 Add a family to view reports</div>';
    return;
  }
  appState.families.forEach(f => {
    const btn = document.createElement('div');
    btn.className = 'family-tab-btn' + (f.id === appState.currentFamilyId ? ' active' : '');
    btn.id = `family-btn-${f.id}`;
    btn.innerHTML = `
      <span class="fam-tab-name">${escHtml(f.name)}</span>
      <span class="fam-count">${f.records.length}</span>
      <span class="fam-tab-actions">
        <button class="fam-action-btn edit" onclick="event.stopPropagation(); startEditFamily('${f.id}')" title="Rename family">✏️</button>
        <button class="fam-action-btn delete" onclick="event.stopPropagation(); removeFamily('${f.id}')" title="Remove family">🗑</button>
      </span>
    `;
    btn.onclick = () => { appState.currentFamilyId = f.id; renderFamilyTabs(); renderAll(); };
    container.appendChild(btn);
  });
}

let editingFamilyId = null;

function startEditFamily(id) {
  const fam = appState.families.find(f => f.id === id);
  if (!fam) return;
  editingFamilyId = id;
  const input = document.getElementById('edit-family-input');
  input.value = fam.name;
  document.getElementById('edit-family-modal').classList.remove('hidden');
}

function closeEditFamilyModal(e) {
  if (e && e.target !== e.currentTarget && e.target.tagName !== 'BUTTON') {
    return;
  }
  document.getElementById('edit-family-modal').classList.add('hidden');
  editingFamilyId = null;
}

function confirmEditFamily() {
  if (!editingFamilyId) return;
  const input = document.getElementById('edit-family-input');
  const name = input.value.trim();
  if (!name) { showToast('Enter a family name', 'error'); return; }
  const existing = appState.families.find(f => f.id !== editingFamilyId && f.name.toLowerCase() === name.toLowerCase());
  if (existing) { showToast('Family name already exists', 'error'); return; }

  const fam = appState.families.find(f => f.id === editingFamilyId);
  if (fam) {
    fam.name = name;
    persistData();
    renderFamilyTabs();
    if (fam.id === appState.currentFamilyId) {
      renderAll();
    }
    showToast('Family renamed successfully', 'success');
  }
  closeEditFamilyModal();
}

function removeFamily(id) {
  const fam = appState.families.find(f => f.id === id);
  if (!fam) return;
  if (!confirm(`Are you sure you want to remove the family "${fam.name}"? This will delete all its records.`)) return;

  appState.families = appState.families.filter(f => f.id !== id);
  persistData();

  if (appState.currentFamilyId === id) {
    appState.currentFamilyId = appState.families[0]?.id || null;
  }

  renderFamilyTabs();
  renderAll();
  showToast(`Family "${fam.name}" removed`, 'success');
}

function addFamily() {
  const input = document.getElementById('new-family-name');
  const name = input.value.trim();
  if (!name) { showToast('Enter a family name', 'error'); return; }
  if (appState.families.find(f => f.name.toLowerCase() === name.toLowerCase())) {
    showToast('Family already exists', 'error'); return;
  }
  const newFamily = { id: 'fam-' + Date.now(), name, records: [] };
  appState.families.push(newFamily);
  appState.currentFamilyId = newFamily.id;
  input.value = '';
  persistData();
  renderFamilyTabs();
  renderAll();
  showToast(`Family "${name}" added!`, 'success');
}

function getCurrentFamily() {
  return appState.families.find(f => f.id === appState.currentFamilyId);
}

// ─────────────────────────────────────
//  STATS CARDS
// ─────────────────────────────────────
function renderStats() {
  const fam = getCurrentFamily();

  // Helper to reset all stats to placeholder
  function clearStats() {
    document.getElementById('stat-total-units').textContent = '— kWh';
    document.getElementById('stat-total-bill').textContent = '₹—';
    document.getElementById('stat-forecast-units').textContent = '— kWh';
    const vsAvgEl = document.getElementById('stat-vs-avg');
    const vsAvgSubEl = document.getElementById('stat-vs-avg-sub');
    vsAvgEl.textContent = '—';
    vsAvgEl.className = 'stat-value';
    vsAvgSubEl.textContent = '';
  }

  if (!fam || fam.records.length === 0) { clearStats(); return; }

  const records = fam.records;

  const totalUnits = records.reduce((s, r) => s + (parseFloat(r.units) || 0), 0);
  const totalBill = records.reduce((s, r) => s + (parseFloat(r.bill_amount) || 0), 0);

  const forecast = computeForecast(records);
  const nextMonthUnits = forecast[0]?.units || 0;
  const nextNextUnits = forecast[1]?.units || 0;
  const forecastTotal = nextMonthUnits + nextNextUnits;

  const avg = records.length > 0 ? totalUnits / records.length : 0;
  const biAvg = avg * 2;
  const vsAvg = biAvg > 0 ? ((forecastTotal - biAvg) / biAvg * 100) : 0;

  document.getElementById('stat-total-units').textContent =
    `${totalUnits.toLocaleString('en-IN')} kWh`;
  document.getElementById('stat-total-bill').textContent =
    `₹${totalBill.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
  document.getElementById('stat-forecast-units').textContent =
    forecastTotal > 0 ? `${Math.round(forecastTotal)} kWh` : '—';

  const vsAvgEl = document.getElementById('stat-vs-avg');
  const vsAvgSubEl = document.getElementById('stat-vs-avg-sub');
  if (records.length > 0 && forecastTotal > 0) {
    const sign = vsAvg >= 0 ? '+' : '';
    vsAvgEl.textContent = `${sign}${Math.round(vsAvg)}%`;
    vsAvgEl.className = 'stat-value ' + (vsAvg < 0 ? 'negative' : 'positive');
    const predBiMonthlyBill = forecast.reduce((s, r) => s + (r.bill_amount || 0), 0);
    vsAvgSubEl.textContent = `₹${Math.round(predBiMonthlyBill).toLocaleString('en-IN')} predicted`;
  } else {
    vsAvgEl.textContent = '—';
    vsAvgEl.className = 'stat-value';
    vsAvgSubEl.textContent = '';
  }
}

// ─────────────────────────────────────
//  FORECAST ENGINE — reads from cache populated by triggerForecastFetch()
// ─────────────────────────────────────
function computeForecast(records) {
  if (records.length === 0) return [];
  const hash = getRecordsHash(records);
  const fam = getCurrentFamily();
  const famId = fam ? fam.id : null;
  // Return cached results populated by the Python backend API call
  if (appState.cachedForecast && appState.cachedForecastFamilyId === famId && appState.cachedForecastRecordsHash === hash) {
    return appState.cachedForecast;
  }
  // Return empty — triggerForecastFetch() will populate cache and re-render
  return [];
}

// ─────────────────────────────────────
//  DATE HELPERS
// ─────────────────────────────────────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDate(str) {
  if (!str) return new Date();
  str = String(str).trim();

  // ── ISO YYYY-MM (e.g. 2025-09) ──
  const isoYM = str.match(/^(\d{4})-(\d{1,2})$/);
  if (isoYM) return new Date(+isoYM[1], +isoYM[2] - 1, 1);

  // ── ISO YYYY-MM-DD or YYYY/MM/DD (year first, unambiguous) ──
  const isoFull = str.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})$/);
  if (isoFull) return new Date(+isoFull[1], +isoFull[2] - 1, 1);

  // ── "Sep 2024" / "September 2024" ──
  const my = str.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (my) {
    const idx = MONTHS.findIndex(m => m.toLowerCase() === my[1].substring(0, 3).toLowerCase());
    if (idx >= 0) return new Date(+my[2], idx, 1);
  }

  // ── MM/YYYY or MM-YYYY (two parts, 4-digit year) ──
  const mY2 = str.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (mY2) return new Date(+mY2[2], +mY2[1] - 1, 1);

  // ── MM/YY or MM-YY (two parts, 2-digit year) ──
  const mY3 = str.match(/^(\d{1,2})[\/\-](\d{2})$/);
  if (mY3) {
    const month = +mY3[1];
    const yearVal = +mY3[2];
    const year = yearVal >= 70 ? 1900 + yearVal : 2000 + yearVal;
    if (month >= 1 && month <= 12) return new Date(year, month - 1, 1);
  }

  // ── "Sep 24" / "September 24" (2-digit year) ──
  const my2 = str.match(/^([A-Za-z]+)[\s\-]+(\d{2})$/);
  if (my2) {
    const idx = MONTHS.findIndex(m => m.toLowerCase() === my2[1].substring(0, 3).toLowerCase());
    if (idx >= 0) {
      const yearVal = +my2[2];
      const year = yearVal >= 70 ? 1900 + yearVal : 2000 + yearVal;
      return new Date(year, idx, 1);
    }
  }

  // ── DD/MM/YYYY  or  MM/DD/YYYY  (and variants with - or .) ──
  // Handles Indian (dd/mm/yyyy) and US (mm/dd/yyyy) formats with smart disambiguation.
  const dmy = str.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{4})$/);
  if (dmy) {
    const a = +dmy[1], b = +dmy[2], year = +dmy[3];
    let month;
    if (a > 12) {
      // a cannot be a month → must be DD/MM/YYYY (Indian)
      month = b;
    } else if (b > 12) {
      // b cannot be a month → must be MM/DD/YYYY (US)
      month = a;
    } else {
      // Ambiguous (both ≤ 12): prefer DD/MM/YYYY (Indian format for TN context)
      month = b;
    }
    if (month >= 1 && month <= 12) return new Date(year, month - 1, 1);
  }

  // ── DD/MM/YY  or  MM/DD/YY  (2-digit year) ──
  const dmy2 = str.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-](\d{2})$/);
  if (dmy2) {
    const a = +dmy2[1], b = +dmy2[2];
    const yearVal = +dmy2[3];
    const year = yearVal >= 70 ? 1900 + yearVal : 2000 + yearVal;
    const month = a > 12 ? b : (b > 12 ? a : b); // prefer DD/MM
    if (month >= 1 && month <= 12) return new Date(year, month - 1, 1);
  }

  // ── Native Date parse fallback ──
  const d = new Date(str);
  return isNaN(d) ? new Date() : d;
}

function formatMonthYear(date) {
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function formatMMYYYY(date) {
  // Display as Mon YYYY e.g. Sep 2005
  return `${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

function addMonths(date, n) {
  const d = new Date(date.getFullYear(), date.getMonth() + n, 1);
  return d;
}

function normalizeDate(str) {
  return formatMMYYYY(parseDate(str));
}

// ─────────────────────────────────────
//  FORECAST CHART
// ─────────────────────────────────────
function renderForecastChart() {
  const fam = getCurrentFamily();
  const canvas = document.getElementById('forecast-chart');
  const emptyEl = document.getElementById('forecast-chart-empty');
  const panelEmpty = document.getElementById('forecast-empty-state');
  const panelContent = document.getElementById('forecast-content');
  const ctx = canvas.getContext('2d');

  if (appState.forecastChart) { appState.forecastChart.destroy(); appState.forecastChart = null; }

  if (!fam) {
    // Zero-family state
    if (panelEmpty) {
      panelEmpty.classList.remove('hidden');
      panelEmpty.querySelector('.panel-empty-title').textContent = 'Add family to view report';
      panelEmpty.querySelector('.panel-empty-sub').textContent = 'Please add a family to start tracking usage.';
      panelEmpty.querySelector('.panel-empty-icon').textContent = '👨‍👩‍👧';
      const ctaBtn = document.getElementById('forecast-cta-btn');
      if (ctaBtn) ctaBtn.classList.add('hidden');
    }
    if (panelContent) panelContent.classList.add('hidden');
    return;
  } else if (fam.records.length === 0) {
    // Family exists, but no records
    if (panelEmpty) {
      panelEmpty.classList.remove('hidden');
      panelEmpty.querySelector('.panel-empty-title').textContent = 'No data to forecast';
      panelEmpty.querySelector('.panel-empty-sub').textContent = 'upload data to see result';
      panelEmpty.querySelector('.panel-empty-icon').textContent = '⚡';
      const ctaBtn = document.getElementById('forecast-cta-btn');
      if (ctaBtn) ctaBtn.classList.remove('hidden');
    }
    if (panelContent) panelContent.classList.add('hidden');
    return;
  } else {
    // Show chart content, hide panel empty CTA
    if (panelEmpty) panelEmpty.classList.add('hidden');
    if (panelContent) panelContent.classList.remove('hidden');
    canvas.classList.remove('hidden');
    if (emptyEl) emptyEl.classList.add('hidden');
  }

  const sorted = [...fam.records].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const forecast = computeForecast(sorted);

  const displayActuals = sorted.slice(-12);
  const labels = [...displayActuals.map(r => formatMonthYear(parseDate(r.date))), ...forecast.map(r => formatMonthYear(parseDate(r.date)))];
  const actualUnits = displayActuals.map(r => parseFloat(r.units) || 0);
  // bridge the last actual point into predicted series
  const predUnits = [
    ...Array(displayActuals.length - 1).fill(null),
    actualUnits[actualUnits.length - 1],
    ...forecast.map(r => r.units)
  ];

  const predRadius = Array(labels.length).fill(4);
  predRadius[displayActuals.length - 1] = 0;
  const predHoverRadius = Array(labels.length).fill(7);
  predHoverRadius[displayActuals.length - 1] = 0;

  appState.forecastChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Units (actual)',
          data: actualUnits,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.07)',
          borderWidth: 2.5,
          pointRadius: 4, pointHoverRadius: 7,
          pointBackgroundColor: '#2563eb',
          fill: true, tension: 0.4,
        },
        {
          label: 'Units (predicted)',
          data: predUnits,
          borderColor: '#f59e0b',
          backgroundColor: 'rgba(245,158,11,0.07)',
          borderWidth: 2.5,
          borderDash: [7, 4],
          pointRadius: predRadius,
          pointHoverRadius: predHoverRadius,
          pointBackgroundColor: '#f59e0b',
          fill: true, tension: 0.4,
        }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#fff',
          titleColor: '#0f172a', bodyColor: '#475569',
          borderColor: '#e2e8f0', borderWidth: 1,
          padding: 12, cornerRadius: 10,
          callbacks: {
            label: c => {
              if (c.parsed.y === null) return null;
              if (c.datasetIndex === 1 && c.dataIndex === displayActuals.length - 1) return null;
              return ` ${c.dataset.label}: ${c.parsed.y} kWh`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { font: { size: 11 }, color: '#94a3b8', maxRotation: 45, maxTicksLimit: 14 }
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(0,0,0,0.04)' },
          ticks: { font: { size: 11 }, color: '#94a3b8' }
        }
      }
    }
  });
}

// Helper to fetch same-month data for up to numYears back
function getHistoricalMonthData(sortedRecords, targetMonthIndex, targetYear, numYears = 5) {
  const data = [];
  for (let i = numYears; i >= 1; i--) {
    const year = targetYear - i;
    const rec = sortedRecords.find(r => {
      const d = parseDate(r.date);
      return d.getMonth() === targetMonthIndex && d.getFullYear() === year;
    });
    if (rec) {
      data.push({
        label: formatMonthYear(parseDate(rec.date)),
        units: parseFloat(rec.units) || 0
      });
    }
  }
  return data;
}

// ─────────────────────────────────────
//  COMPARISON CHARTS
// ─────────────────────────────────────
function renderComparisonCharts() {
  const fam = getCurrentFamily();
  const grid = document.getElementById('comparison-grid');

  appState.comparisonCharts.forEach(c => c.destroy());
  appState.comparisonCharts = [];
  grid.innerHTML = '';

  // Panel-level empty state already handled by renderForecastChart
  if (!fam || fam.records.length === 0) {
    return;
  }
  if (fam.records.length < 2) {
    grid.innerHTML = '<div class="comparison-empty-state"><div class="panel-empty-icon" style="font-size:32px">📊</div><span>Need at least 2 records to show historical comparison</span></div>';
    return;
  }

  const sorted = [...fam.records].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const forecast = computeForecast(sorted);

  forecast.forEach((pred, idx) => {
    const predDate = parseDate(pred.date);
    const prevYearDate = addMonths(predDate, -12);
    const prevLabel = formatMonthYear(prevYearDate);
    const past = sorted.find(r => formatMonthYear(parseDate(r.date)) === prevLabel);
    const pastUnits = past ? parseFloat(past.units) : 0;

    const barCanvasId = `comp-chart-bar-${idx}-${Date.now()}`;
    const lineCanvasId = `comp-chart-line-${idx}-${Date.now()}`;
    const card = document.createElement('div');
    card.className = 'comparison-card';

    const histData = getHistoricalMonthData(sorted, predDate.getMonth(), predDate.getFullYear(), 5);

    card.innerHTML = `
      <div class="comparison-card-title">${escHtml(pred.date)} vs Historical ${MONTHS[predDate.getMonth()]}</div>
      <div class="comparison-card-sub">
        Predicted: <strong>${pred.units} kWh</strong> &nbsp;·&nbsp; Predicted Bill: <strong>₹${pred.bill_amount.toLocaleString('en-IN')}</strong>
        <div class="prediction-disclaimer" style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">*Prediction, not exact</div>
      </div>
      <div class="comparison-card-body">
        <div class="comparison-chart-col">
          <div class="comparison-chart-label">1-Year Comparison (Bar)</div>
          <div class="comparison-chart-wrap">
            ${past
        ? `<canvas id="${barCanvasId}"></canvas>`
        : `<div class="comparison-card-message">
                   <div class="comparison-card-message-icon">🔍</div>
                   <div style="font-weight: 600;">No past record found for this month</div>
                 </div>`
      }
          </div>
        </div>
        <div class="comparison-chart-col">
          <div class="comparison-chart-label">5-Year History (Line)</div>
          <div class="comparison-chart-wrap">
            ${histData.length > 0
        ? `<canvas id="${lineCanvasId}"></canvas>`
        : `<div class="comparison-card-message">
                   <div class="comparison-card-message-icon">📊</div>
                   <div style="font-weight: 600;">No past record found for this month</div>
                 </div>`
      }
          </div>
          ${histData.length > 0 && histData.length < 5
        ? `<div class="comparison-card-info-badge">Only ${histData.length} records found for this month</div>`
        : ''
      }
        </div>
      </div>
    `;
    grid.appendChild(card);

    // 1-Year Comparison Bar Chart
    if (past) {
      const barChart = new Chart(document.getElementById(barCanvasId).getContext('2d'), {
        type: 'bar',
        data: {
          labels: [prevLabel, pred.date],
          datasets: [{
            data: [pastUnits, pred.units],
            backgroundColor: ['#3b82f6', '#f59e0b'],
            borderRadius: 6, borderSkipped: false,
          }]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => ` ${c.parsed.y} kWh` } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#94a3b8' } },
            y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { size: 9 }, color: '#94a3b8' } }
          }
        }
      });
      appState.comparisonCharts.push(barChart);
    }

    // 5-Year History Line Chart
    if (histData.length > 0) {
      const lineLabels = [...histData.map(h => h.label), pred.date];
      const lineActualData = [...histData.map(h => h.units), null];
      const linePredictedData = [...Array(histData.length).fill(null), pred.units];

      // Bridge last actual point to prediction for smooth line visualization
      linePredictedData[histData.length - 1] = histData[histData.length - 1].units;

      const lineChart = new Chart(document.getElementById(lineCanvasId).getContext('2d'), {
        type: 'line',
        data: {
          labels: lineLabels,
          datasets: [
            {
              label: 'Actual',
              data: lineActualData,
              borderColor: '#3b82f6',
              backgroundColor: 'rgba(59,130,246,0.05)',
              borderWidth: 2,
              pointRadius: 3,
              fill: false,
              tension: 0.3
            },
            {
              label: 'Predicted',
              data: linePredictedData,
              borderColor: '#f59e0b',
              backgroundColor: 'rgba(245,158,11,0.05)',
              borderWidth: 2,
              borderDash: [5, 3],
              pointRadius: 3,
              fill: false,
              tension: 0.3
            }
          ]
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: c => c.parsed.y === null ? null : ` ${c.dataset.label}: ${c.parsed.y} kWh` } }
          },
          scales: {
            x: { grid: { display: false }, ticks: { font: { size: 10 }, color: '#94a3b8' } },
            y: { beginAtZero: true, grid: { color: 'rgba(0,0,0,0.04)' }, ticks: { font: { size: 9 }, color: '#94a3b8' } }
          }
        }
      });
      appState.comparisonCharts.push(lineChart);
    }
  });
}

// ─────────────────────────────────────
//  DATASET TABLE
// ─────────────────────────────────────
function renderDatasetTable() {
  const fam = getCurrentFamily();
  const tbody = document.getElementById('data-table-body');
  const titleEl = document.getElementById('dataset-title');
  const metaEl = document.getElementById('dataset-meta');
  const emptyState = document.getElementById('dataset-empty-state');
  const content = document.getElementById('dataset-content');

  if (!fam) {
    if (emptyState) {
      emptyState.classList.remove('hidden');
      emptyState.querySelector('.panel-empty-title').textContent = 'Add family to view report';
      emptyState.querySelector('.panel-empty-sub').textContent = 'Please add a family to start tracking usage.';
      emptyState.querySelector('.panel-empty-icon').textContent = '👨‍👩‍👧';
      const ctaBtn = document.getElementById('dataset-cta-btn');
      if (ctaBtn) ctaBtn.classList.add('hidden');
    }
    if (content) content.classList.add('hidden');
    return;
  }

  titleEl.textContent = `${fam.name} dataset`;
  const sorted = [...fam.records].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  metaEl.textContent = `${sorted.length} rows · date · occupants · units · bill_amount`;

  if (sorted.length === 0) {
    // Show panel-level empty state, hide table
    if (emptyState) {
      emptyState.classList.remove('hidden');
      emptyState.querySelector('.panel-empty-title').textContent = 'No records yet';
      emptyState.querySelector('.panel-empty-sub').textContent = 'upload data to see result';
      emptyState.querySelector('.panel-empty-icon').textContent = '📂';
      const ctaBtn = document.getElementById('dataset-cta-btn');
      if (ctaBtn) ctaBtn.classList.remove('hidden');
    }
    if (content) content.classList.add('hidden');
    return;
  }

  // Show table, hide empty state
  if (emptyState) emptyState.classList.add('hidden');
  if (content) content.classList.remove('hidden');

  tbody.innerHTML = sorted.map(r => {
    const origIdx = fam.records.indexOf(r);
    const billDisplay = r.bill_amount != null
      ? `₹${parseFloat(r.bill_amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`
      : '—';
    return `
      <tr>
        <td>${normalizeDate(r.date)}</td>
        <td class="td-center">${r.occupants}</td>
        <td class="td-right td-blue">${parseFloat(r.units).toLocaleString('en-IN')}</td>
        <td class="td-right">${billDisplay}</td>
        <td><button class="btn-delete-row" onclick="deleteRecord(${origIdx})" title="Delete">🗑</button></td>
      </tr>`;
  }).join('');
}

function deleteRecord(idx) {
  const fam = getCurrentFamily();
  if (!fam) return;
  fam.records.splice(idx, 1);
  persistData();
  renderAll();
  showToast('Record deleted', 'success');
}

function clearDataset() {
  const fam = getCurrentFamily();
  if (!fam) return;
  if (!confirm(`Clear all ${fam.records.length} records for "${fam.name}"?\nThis cannot be undone.`)) return;
  fam.records = [];
  persistData();
  renderAll();
  showToast('Dataset cleared', 'success');
}

// ─────────────────────────────────────
//  EXPORT CSV
// ─────────────────────────────────────
function exportCSV() {
  const fam = getCurrentFamily();
  if (!fam || fam.records.length === 0) { showToast('No data to export', 'error'); return; }
  const sorted = [...fam.records].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  const header = 'date,occupants,units,bill_amount';
  const rows = sorted.map(r =>
    `"${normalizeDate(r.date)}",${r.occupants},${r.units},${r.bill_amount ?? ''}`
  );
  downloadBlob([header, ...rows].join('\n'), `${fam.name.replace(/\s+/g, '-')}_dataset.csv`, 'text/csv');
  showToast('CSV exported!', 'success');
}

function downloadTemplate() {
  const csv = 'date,occupants,units,bill_amount\nJan 2025,4,320,2720\nFeb 2025,4,410,3485\nMar 2025,4,500,4250';
  downloadBlob(csv, 'wattcast_template.csv', 'text/csv');
  showToast('Template downloaded!', 'success');
}

function downloadBlob(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─────────────────────────────────────
//  MANUAL RECORD ADD
// ─────────────────────────────────────
function addManualRecord(e) {
  e.preventDefault();
  const fam = getCurrentFamily();
  if (!fam) { showToast('Select a family first', 'error'); return; }

  const dateVal = document.getElementById('rec-date').value.trim();
  const occupants = parseInt(document.getElementById('rec-occupants').value);
  const units = parseFloat(document.getElementById('rec-units').value);
  const bill = parseFloat(document.getElementById('rec-bill').value);

  if (!dateVal || isNaN(occupants) || isNaN(units) || isNaN(bill)) {
    showToast('Please fill in all fields', 'error'); return;
  }

  const normalized = normalizeDate(dateVal);
  const existing = fam.records.find(r => normalizeDate(r.date) === normalized);

  if (existing) {
    if (!confirm(`A record for ${normalized} already exists. Replace it?`)) return;
    Object.assign(existing, { occupants, units, bill_amount: bill });
  } else {
    fam.records.push({ date: normalized, occupants, units, bill_amount: bill });
  }

  persistData();
  document.getElementById('manual-form').reset();
  renderAll();
  showToast(`Record for ${normalized} added!`, 'success');
}

// ─────────────────────────────────────
//  FILE UPLOAD  (CSV / XLS / XLSX)
// ─────────────────────────────────────
function onDragOver(e) { e.preventDefault(); document.getElementById('dropzone').classList.add('drag-over'); }
function onDragLeave() { document.getElementById('dropzone').classList.remove('drag-over'); }
function onDrop(e) { e.preventDefault(); onDragLeave(); const f = e.dataTransfer.files[0]; if (f) processFile(f); }
function handleFileInput(e) { const f = e.target.files[0]; if (f) processFile(f); e.target.value = ''; }

function processFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const statusEl = document.getElementById('upload-status');
  statusEl.className = 'upload-status';
  statusEl.textContent = `⏳ Processing "${file.name}"…`;
  statusEl.classList.remove('hidden');

  if (ext === 'csv') {
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: res => ingestRows(res.data, file.name),
      error: err => setUploadError('CSV parse error: ' + err.message),
    });
  } else if (ext === 'xls' || ext === 'xlsx') {
    const reader = new FileReader();
    reader.onload = ev => {
      try {
        const wb = XLSX.read(ev.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
        ingestRows(rows, file.name);
      } catch (err) { setUploadError('Excel parse error: ' + err.message); }
    };
    reader.readAsArrayBuffer(file);
  } else {
    setUploadError('Unsupported file type. Use .csv, .xls, or .xlsx');
  }
}

function setUploadError(msg) {
  const el = document.getElementById('upload-status');
  el.className = 'upload-status error';
  el.textContent = '❌ ' + msg;
}

function ingestRows(rows, filename) {
  const fam = getCurrentFamily();
  if (!fam) { setUploadError('No family selected.'); return; }
  if (!rows || rows.length === 0) { setUploadError('No data rows found in file.'); return; }

  const colMap = detectColumns(Object.keys(rows[0]));

  if (!colMap.date) { setUploadError('Cannot find a "date" column. Check your file headers.'); return; }
  if (!colMap.units) { setUploadError('Cannot find a "units" column. Check your file headers.'); return; }

  // Detect date format across whole column before parsing any row
  const allRawDates = rows.map(r => String(r[colMap.date] ?? '').trim()).filter(Boolean);
  const dateFormatHint = detectDateColumnFormat(allRawDates);

  const parsed = [];
  const errors = [];

  rows.forEach((row, i) => {
    const rawDate = String(row[colMap.date] ?? '').trim();
    const rawUnits = row[colMap.units];
    const rawOcc = colMap.occupants ? row[colMap.occupants] : '';
    const rawBill = colMap.bill ? row[colMap.bill] : '';

    if (!rawDate) { errors.push(`Row ${i + 2}: empty date`); return; }
    const units = parseFloat(rawUnits);
    if (isNaN(units)) { errors.push(`Row ${i + 2}: invalid units "${rawUnits}"`); return; }

    const occupants = rawOcc !== '' ? parseInt(rawOcc) : 1;
    const bill_amount = rawBill !== '' ? parseFloat(rawBill) : null;

    // Use format-aware date parsing
    const parsedDate = parseDateWithHint(rawDate, dateFormatHint);

    parsed.push({
      date: formatMMYYYY(parsedDate),
      occupants: isNaN(occupants) ? 1 : occupants,
      units,
      bill_amount: (bill_amount !== null && !isNaN(bill_amount)) ? bill_amount : null,
    });
  });

  if (parsed.length === 0) { setUploadError(`No valid rows parsed. Errors: ${errors.slice(0, 3).join('; ')}`); return; }

  fam.records = parsed;
  persistData();
  renderAll();

  const formatLabel = dateFormatHint === 'mdy' ? 'MM/DD/YYYY' : 'DD/MM/YYYY';
  const statusEl = document.getElementById('upload-status');
  statusEl.className = 'upload-status success';
  statusEl.textContent = `✅ Imported ${parsed.length} records from "${filename}" (dates interpreted as ${formatLabel})` +
    (errors.length ? ` (${errors.length} row${errors.length > 1 ? 's' : ''} skipped)` : '');

  showToast(`Imported ${parsed.length} records!`, 'success');
}

// ─────────────────────────────────────
//  DATE FORMAT DETECTION
// ─────────────────────────────────────

/**
 * Analyzes a column of date strings to detect if they are dd/mm/yyyy or mm/dd/yyyy.
 * Returns 'dmy' (day first, Indian) or 'mdy' (month first, US) or 'auto' (no ambiguous dates found).
 *
 * Logic:
 * - Any value where part1 > 12 → conclusively DD/MM/YYYY (day first)
 * - Any value where part2 > 12 → conclusively MM/DD/YYYY (month first)
 * - Tally votes from unambiguous values; majority wins.
 * - If tied/all ambiguous, default to 'dmy' (Indian/TN context).
 */
function detectDateColumnFormat(rawDateStrings) {
  const dmyPattern = /^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-]((\d{4})|(\d{2}))$/;
  let dmyScore = 0;
  let mdyScore = 0;
  const aVals = []; // first parts from ambiguous rows
  const bVals = []; // second parts from ambiguous rows

  for (const raw of rawDateStrings) {
    const str = String(raw || '').trim();
    const m = str.match(dmyPattern);
    if (!m) continue;
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a > 12 && b <= 12) { dmyScore += 2; }   // conclusive: a is day
    else if (b > 12 && a <= 12) { mdyScore += 2; } // conclusive: b is day
    else {
      // Both ≤12 — ambiguous. Collect for distribution analysis.
      aVals.push(a);
      bVals.push(b);
    }
  }

  if (dmyScore > mdyScore) return 'dmy';
  if (mdyScore > dmyScore) return 'mdy';

  // ── Distribution analysis for "day is always 01" datasets ──
  // When the day is always 1 (or very small), one side will be nearly constant
  // while the other side will vary across months (1–12).
  if (aVals.length > 0) {
    const aUnique = new Set(aVals).size;
    const bUnique = new Set(bVals).size;
    const aMax = Math.max(...aVals);
    const bMax = Math.max(...bVals);

    // b is always small (day=01) while a varies → MM/DD/YYYY → 'mdy'
    if (bMax <= 3 && aUnique > bUnique) return 'mdy';
    // a is always small (day=01) while b varies → DD/MM/YYYY → 'dmy'
    if (aMax <= 3 && bUnique > aUnique) return 'dmy';
  }

  return 'dmy'; // Default: Indian DD/MM/YYYY for TN context
}

/**
 * Parse a date string with a known format hint ('dmy' or 'mdy') for the ambiguous case.
 * Delegates to parseDate for unambiguous patterns.
 */
function parseDateWithHint(str, formatHint) {
  if (!str) return new Date();
  str = String(str).trim();

  // ── Excel serial date number (e.g. 38353 = Sep 2004) ──
  // Excel stores dates as integers counting days since 1900-01-01 (with leap year bug)
  const serial = parseInt(str, 10);
  if (!isNaN(serial) && /^\d{5}$/.test(str)) {
    // Excel epoch: day 1 = Jan 1 1900; adjust for Excel's leap year bug
    const excelEpoch = new Date(1899, 11, 30);
    const msPerDay = 86400000;
    const d = new Date(excelEpoch.getTime() + serial * msPerDay);
    return isNaN(d) ? new Date() : d;
  }

  // Only apply hint to ambiguous dd/mm/yyyy or mm/dd/yyyy formats
  const dmy = str.match(/^(\d{1,2})[\/\.\-](\d{1,2})[\/\.\-]((\d{4})|(\d{2}))$/);
  if (dmy) {
    const a = parseInt(dmy[1], 10);
    const b = parseInt(dmy[2], 10);
    const yearStr = dmy[3];
    let year;
    if (yearStr.length === 2) {
      const yearVal = parseInt(yearStr, 10);
      year = yearVal >= 70 ? 1900 + yearVal : 2000 + yearVal;
    } else {
      year = parseInt(yearStr, 10);
    }
    let month;
    if (a > 12) {
      month = b; // must be DD/MM
    } else if (b > 12) {
      month = a; // must be MM/DD
    } else {
      // Ambiguous: use format hint
      month = (formatHint === 'mdy') ? a : b;
    }
    if (month >= 1 && month <= 12) return new Date(year, month - 1, 1);
  }

  // Fallback to standard parseDate for all other formats
  return parseDate(str);
}

function detectColumns(keys) {
  const norm = s => s.toLowerCase().replace(/[\s_\-().]/g, '');
  const find = aliases => keys.find(k => aliases.includes(norm(k)));
  return {
    date: find(['date', 'month', 'period', 'monthyear', 'recorddate', 'billingmonth']),
    units: find(['units', 'kwh', 'consumption', 'electricityunits', 'unitskwh', 'unitsconsumed']),
    occupants: find(['occupants', 'members', 'people', 'persons', 'familysize', 'householdsize']),
    bill: find(['billamount', 'bill', 'amount', 'totalamount', 'billamt', 'totalcharges', 'totalamountrs']),
  };
}

// ─────────────────────────────────────
//  TAB SWITCHING
// ─────────────────────────────────────
function switchTab(tab) {
  appState.currentTab = tab;
  ['forecast', 'dataset', 'upload', 'calculator'].forEach(t => {
    document.getElementById(`panel-${t}`)?.classList.toggle('active', t === tab);
    document.getElementById(`tab-${t}`)?.classList.toggle('active', t === tab);
  });
}

// ─────────────────────────────────────
//  RENDER ALL
// ─────────────────────────────────────
function renderAll() {
  // Render synchronous parts immediately
  renderDatasetTable();
  renderFamilyTabs();
  // Kick off async backend fetch; it will call renderStats/renderForecastChart/renderComparisonCharts
  // once the Python model API returns predictions
  triggerForecastFetch();
}

// ─────────────────────────────────────
//  PERSIST DATA
// ─────────────────────────────────────
function persistData() {
  if (appState.currentUser) saveAppData(appState.currentUser.id, appState.families);
}

// ─────────────────────────────────────
//  TOAST
// ─────────────────────────────────────
function showToast(msg, type = '') {
  document.querySelectorAll('.toast').forEach(t => t.remove());
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(() => {
    toast.style.cssText += 'opacity:0;transform:translateY(20px);transition:0.3s';
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

// ─────────────────────────────────────
//  UTILITY
// ─────────────────────────────────────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─────────────────────────────────────
//  BILL CALCULATOR
// ─────────────────────────────────────
function calculateManualBill(e) {
  e.preventDefault();
  const unitsInput = document.getElementById('calc-units');
  const resultBox = document.getElementById('calc-result');
  const resultVal = document.getElementById('calc-bill-val');
  const resultSub = document.getElementById('calc-bill-sub');
  const breakdownBox = document.getElementById('calc-breakdown');
  const breakdownBody = document.getElementById('calc-breakdown-body');

  if (!unitsInput || !resultBox || !resultVal) return;

  const units = parseFloat(unitsInput.value);
  if (isNaN(units) || units < 0) {
    showToast('Please enter a valid unit consumption amount.', 'error');
    return;
  }

  const bill = calculateTamilNaduBill(units);
  resultVal.textContent = `₹${Math.round(bill).toLocaleString('en-IN')}`;
  if (resultSub) resultSub.textContent = `for ${units.toLocaleString('en-IN')} kWh consumed`;
  resultBox.classList.remove('hidden');

  // Build slab breakdown
  if (breakdownBox && breakdownBody) {
    const isAbove500 = units > 500;
    const slabsAbove500 = [
      { label: '1 – 100', limit: 100, rate: 0.0 },
      { label: '101 – 400', limit: 300, rate: 4.70 },
      { label: '401 – 500', limit: 100, rate: 6.30 },
      { label: '501 – 600', limit: 100, rate: 8.40 },
      { label: '601 – 800', limit: 200, rate: 9.45 },
      { label: '801 – 1000', limit: 200, rate: 10.50 },
      { label: 'Above 1000', limit: Infinity, rate: 11.55 },
    ];
    const slabsBelow500 = [
      { label: '1 – 200', limit: 200, rate: 0.0 },
      { label: '201 – 400', limit: 200, rate: 4.70 },
      { label: '401 – 500', limit: Infinity, rate: 6.30 },
    ];
    const slabs = isAbove500 ? slabsAbove500 : slabsBelow500;
    let remaining = units;
    let rows = '';
    let totalAmt = 0;
    for (const slab of slabs) {
      if (remaining <= 0) break;
      const used = Math.min(remaining, slab.limit);
      const amt = used * slab.rate;
      totalAmt += amt;
      remaining -= used;
      const rateLabel = slab.rate === 0 ? '<span class="slab-free">Free</span>' : `₹${slab.rate.toFixed(2)}`;
      rows += `<tr><td>${slab.label}</td><td>${used.toLocaleString('en-IN')} kWh</td><td>${rateLabel}</td><td>₹${Math.round(amt).toLocaleString('en-IN')}</td></tr>`;
    }
    rows += `<tr style="font-weight:700; background:#f0f7ff;"><td colspan="3">Total</td><td>₹${Math.round(totalAmt).toLocaleString('en-IN')}</td></tr>`;
    breakdownBody.innerHTML = rows;
    breakdownBox.classList.remove('hidden');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadUsers(); // seed demo user
  const session = loadSession();
  if (session) enterDashboard(session);
});
