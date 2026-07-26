// Pocket Ledger - Main application

import { db, initDB, getSetting, setSetting } from './db.js';
import { fmt, fmtDate, fmtDateShort, dayName, today, isoDate, addDays, diffDays, cycleForDate, monthlyEquivalent, dailyEquivalent, delegate } from './utils.js';
import { calcRollingBalance, calcProjectedBalances, getCurrentCycle, getCycleForDate, calcDailyAllowance, getCycleBreakdown, generateDistributionChildren, getSavingsTarget } from './engine.js';
import { signInWithGoogle, handleRedirectResult, signOutUser, auth } from './firebase.js';
import { initSync, queueWrite, queueDelete, syncState, onSync, pullFromFirestore, uploadAllToFirestore } from './sync.js';

const state = {
  view: 'balance',
  entryType: 'expense',
  entryPence: 0,
  entryCategory: null,
  entryDate: today(),
  entryNote: '',
  entryEditId: null,
  txnSearchQuery: '',
  txnSearchAll: false,
  txnFilter: 'all',
  recurringTab: 'expenses',
  analysisPeriod: 'month',
  analysisViewingCycle: null,
  analysisCatCompare: 'lastMonth',
  viewingCycle: null,
  pendingSync: 0,
  currentUser: null,
  txnMonth: null,
  prevBalance: null,
};

const viewContainer = document.getElementById('view');
const navBtns = document.querySelectorAll('.nav-btn');

function animateCounter(el, from, to, duration = 420) {
  const start = performance.now();
  const step = ts => {
    const t = Math.min((ts - start) / duration, 1);
    const ease = 1 - Math.pow(1 - t, 3);
    el.textContent = fmt(from + (to - from) * ease);
    if (t < 1) requestAnimationFrame(step);
    else el.textContent = fmt(to);
  };
  requestAnimationFrame(step);
}

function navigate(view, params = {}) {
  if (view === 'analysis' && state.view !== 'analysis') state.analysisViewingCycle = null;
  Object.assign(state, params);
  state.view = view;
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderView(view);
}

async function renderView(view) {
  viewContainer.innerHTML = '<div class="spinner"></div>';
  try {
    switch (view) {
      case 'balance':      await renderBalance(); break;
      case 'transactions': await renderTransactions(); break;
      case 'analysis':     await renderAnalysis(); break;
      case 'breakdown':    await renderBreakdown(); break;
      case 'recurring':    state.recurringCycle = null; await renderRecurring(); break;
      case 'distributions':await renderDistributions(); break;
      case 'extraIncomes': await renderExtraIncomes(); break;
      case 'accounts':     await renderAccounts(); break;
      case 'netWealth':    await renderNetWealth(); break;
      case 'bankGilulu':   await renderBankGilulu(); break;
      case 'settings':     await renderSettings(); break;
      case 'import':       renderImport(); break;
      default:             await renderBalance();
    }
  } catch (err) {
    viewContainer.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Something went wrong</div><div class="empty-text">${err.message}</div></div>`;
    console.error(err);
  }
}

function showToast(msg) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2200);
}

async function renderBalance() {
  const [projections, cycle] = await Promise.all([
    calcProjectedBalances(3),
    getCurrentCycle(),
  ]);

  const todayBal = projections[0].balance;
  const maxBal = Math.max(...projections.map(p => Math.abs(p.balance)), 1);

  const segments = n => {
    const segs = Math.max(1, Math.min(8, Math.round(Math.abs(n) / (maxBal / 8))));
    return Array.from({ length: segs }, () => '<div class="proj-bar-segment"></div>').join('');
  };

  const dayLabels = projections.map((p, i) => {
    if (i === 0) return 'Today';
    const d = new Date(p.date + 'T12:00:00');
    return d.toLocaleDateString('en-GB', { weekday: 'short' });
  });

  const pendingCount = await db.syncQueue.where('status').equals('pending').count();

  // Bi-monthly net wealth prompt: even months where no snapshot exists this month
  const todayMonth = today().slice(0, 7);
  const todayMonthNum = new Date().getMonth() + 1;
  const isEvenMonth = todayMonthNum % 2 === 0;
  let wealthBanner = '';
  if (isEvenMonth) {
    const thisMonthSnapshots = await db.accountSnapshots.filter(s => s.date.startsWith(todayMonth)).count();
    if (thisMonthSnapshots === 0) {
      wealthBanner = `<div class="wealth-banner" id="wealth-banner-btn">📊 Time for your bi-monthly net wealth update — tap to enter</div>`;
    }
  }

  viewContainer.innerHTML = `
    <div class="balance-screen ${todayBal < 0 ? 'negative' : ''}">
      ${pendingCount > 0 ? `<div class="sync-banner">${pendingCount} change${pendingCount > 1 ? 's' : ''} pending sync</div>` : ''}
      ${wealthBanner}
      <div class="balance-header">
        <button class="balance-menu-btn" id="balance-menu-btn">
          <svg width="22" height="16" viewBox="0 0 22 16" fill="none">
            <rect y="0" width="22" height="2" rx="1" fill="white"/>
            <rect y="7" width="16" height="2" rx="1" fill="white"/>
            <rect y="14" width="22" height="2" rx="1" fill="white"/>
          </svg>
        </button>
        <span class="balance-title">Balance</span>
        <button class="balance-settings-btn" id="balance-cycle-btn" title="Budget breakdown">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.8">
            <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
        </button>
      </div>

      <div class="balance-amount-area">
        <div class="balance-amount ${todayBal < 0 ? 'negative' : ''}">${fmt(todayBal)}</div>
        <div class="balance-label">${fmtDate(cycle.start)} - ${fmtDate(cycle.end)}</div>
      </div>

      <div class="balance-projection">
        ${projections.map((p, i) => {
          const targetH = Math.max(20, Math.round(Math.abs(p.balance) / maxBal * 80));
          return `
          <div class="proj-day">
            <div class="proj-bar-wrap">
              <div class="proj-bar" style="height:4px" data-target-h="${targetH}">
                ${segments(p.balance)}
              </div>
            </div>
            <div class="proj-divider"></div>
            <div class="proj-label">${dayLabels[i]}</div>
            <div class="proj-amount">${fmt(p.balance)}</div>
          </div>
        `}).join('')}
      </div>

      <div class="balance-fabs">
        <button class="fab fab-income" id="fab-income" aria-label="Add income">+</button>
        <button class="fab fab-expense" id="fab-expense" aria-label="Add expense">-</button>
      </div>
    </div>
  `;

  // Animate balance counter if it changed
  const prevBal = state.prevBalance;
  state.prevBalance = todayBal;
  if (prevBal !== null && Math.abs(prevBal - todayBal) > 0.005) {
    animateCounter(viewContainer.querySelector('.balance-amount'), prevBal, todayBal, 630);
  }

  // Animate projection bars (always — gives a nice entrance on every load)
  requestAnimationFrame(() => requestAnimationFrame(() => {
    viewContainer.querySelectorAll('.proj-bar').forEach(bar => {
      bar.style.transition = 'height 0.675s cubic-bezier(0.34, 1.56, 0.64, 1)';
      bar.style.height = bar.dataset.targetH + 'px';
    });
  }));

  viewContainer.querySelector('#fab-income').onclick = () => openEntry('income');
  viewContainer.querySelector('#fab-expense').onclick = () => openEntry('expense');
  viewContainer.querySelector('#balance-menu-btn').onclick = () => navigate('settings');
  viewContainer.querySelector('#balance-cycle-btn').onclick = () => navigate('breakdown');
  const wealthBannerBtn = viewContainer.querySelector('#wealth-banner-btn');
  if (wealthBannerBtn) wealthBannerBtn.onclick = () => navigate('netWealth');
}

async function openEntry(type, existingTxn = null) {
  state.entryType = type;
  state.entryPence = existingTxn ? Math.round(Math.abs(existingTxn.amount) * 100) : 0;
  state.entryCategory = existingTxn?.categoryId ?? null;
  state.entryDate = existingTxn?.date ?? today();
  state.entryNote = existingTxn?.note ?? '';
  state.entryEditId = existingTxn?.id ?? null;

  const cats = (await db.categories.toArray())
    .filter(c => !c.isArchived && (!!c.isIncome === (type === 'income')))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const selectedCat = cats.find(c => c.id === state.entryCategory);
  const hasCategory = !!selectedCat;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.id = 'entry-overlay';

  overlay.innerHTML = `
    <div class="sheet" id="entry-sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <button class="sheet-close" id="entry-close">✕</button>
        <span class="sheet-title">${existingTxn ? 'Edit' : 'Add'} ${type === 'income' ? 'Income' : 'Expense'}</span>
        <button class="entry-save-btn" id="entry-save">✓</button>
      </div>
      <div class="sheet-body">
        <div class="entry-amount-display ${state.entryPence === 0 ? 'placeholder' : ''}" id="entry-display">
          ${state.entryPence > 0 ? fmt(state.entryPence / 100) : '£0.00'}
        </div>

        <div class="entry-field cat-collapsed-row" id="cat-collapsed">
          <span class="entry-field-icon">🏷️</span>
          <label>Category</label>
          <div id="cat-preview" style="flex:1;font-size:15px;color:var(--text)">
            ${hasCategory ? `<span style="margin-right:4px">${selectedCat.icon}</span>${selectedCat.name}` : `<span style="color:var(--text-2)">${type === 'expense' ? 'Misc (auto)' : 'Select…'}</span>`}
          </div>
          <span style="color:var(--text-2);font-size:18px">›</span>
        </div>

        <div class="entry-fields">
          <div class="entry-field" id="date-field" style="cursor:pointer">
            <span class="entry-field-icon">📅</span>
            <label>Date</label>
            <span id="entry-date-display" style="flex:1;font-size:15px;color:var(--text);text-align:right">${fmtDate(state.entryDate)}</span>
            <span style="color:var(--text-2);font-size:18px">›</span>
          </div>
          <div class="entry-field">
            <span class="entry-field-icon">📝</span>
            <label>Note</label>
            <input type="text" id="entry-note" placeholder="Optional note" value="${state.entryNote}" maxlength="200" autocomplete="off">
          </div>
          <div id="note-suggestions" class="note-suggestions"></div>
        </div>
      </div>

      <div class="numpad">
        ${['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(k => `
          <button class="numpad-key ${k === '⌫' ? 'delete' : ''}" data-key="${k}">${k}</button>
        `).join('')}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeEntry(); });
  overlay.querySelector('#entry-close').onclick = closeEntry;

  overlay.querySelector('#cat-collapsed').onclick = () => {
    openCategoryPicker(cats, state.entryCategory, (catId, catName, catIcon) => {
      state.entryCategory = catId;
      overlay.querySelector('#cat-preview').innerHTML = catId
        ? `<span style="margin-right:4px">${catIcon}</span>${catName}`
        : `<span style="color:var(--text-2)">Misc (auto)</span>`;
      setupNoteAutocomplete(overlay);
    });
  };

  delegate(overlay, 'click', '.numpad-key:not(.action)', (e, el) => {
    const key = el.dataset.key;
    if (key === '⌫') {
      state.entryPence = Math.floor(state.entryPence / 10);
    } else if (key === '.') {
      // no-op in smart pence mode — digits auto-fill from right
    } else {
      const next = state.entryPence * 10 + parseInt(key);
      if (next <= 9999999) state.entryPence = next;
    }
    el.classList.add('pressed');
    setTimeout(() => el.classList.remove('pressed'), 120);
    updateAmountDisplay(overlay);
  });

  overlay.querySelector('#date-field').onclick = () => {
    openDatePicker(state.entryDate, today(), date => {
      state.entryDate = date;
      overlay.querySelector('#entry-date-display').textContent = fmtDate(date);
    });
  };
  overlay.querySelector('#entry-note').oninput = e => { state.entryNote = e.target.value; };
  overlay.querySelector('#entry-save').onclick = () => saveEntry(overlay);

  if (state.entryCategory) setupNoteAutocomplete(overlay);
}

function updateAmountDisplay(overlay) {
  const display = overlay.querySelector('#entry-display');
  if (state.entryPence === 0) {
    display.textContent = '£0.00';
    display.classList.add('placeholder');
  } else {
    display.textContent = fmt(state.entryPence / 100);
    display.classList.remove('placeholder');
  }
}

function addSwipeToDelete(container) {
  let startX = 0, startY = 0, activeRow = null, tracking = false;
  const THRESHOLD = 60;

  container.addEventListener('touchstart', e => {
    const row = e.target.closest('.txn-row[data-txn-id]');
    if (!row) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    activeRow = row;
    tracking = false;
  }, { passive: true });

  container.addEventListener('touchmove', e => {
    if (!activeRow) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (!tracking) {
      if (Math.abs(dy) > Math.abs(dx)) { activeRow = null; return; }
      tracking = true;
    }
    if (dx < 0) {
      activeRow.style.transition = 'none';
      activeRow.style.transform = `translateX(${Math.max(dx, -80)}px)`;
    }
  }, { passive: true });

  container.addEventListener('touchend', e => {
    if (!activeRow || !tracking) return;
    const dx = e.changedTouches[0].clientX - startX;
    activeRow.style.transition = 'transform .2s ease';
    if (dx < -THRESHOLD) {
      activeRow.style.transform = 'translateX(-72px)';
      activeRow.dataset.swiped = 'true';
    } else {
      activeRow.style.transform = '';
      delete activeRow.dataset.swiped;
    }
    activeRow = null;
  });

  // Tap anywhere outside a swiped row to reset it
  container.addEventListener('touchstart', e => {
    const swiped = container.querySelectorAll('.txn-row[data-swiped]');
    swiped.forEach(row => {
      if (!row.contains(e.target)) {
        row.style.transition = 'transform .2s ease';
        row.style.transform = '';
        delete row.dataset.swiped;
      }
    });
  }, { passive: true });
}

function openDatePicker(currentDate, maxDate, onSelect) {
  let [viewY, viewM] = currentDate.split('-').map(Number);

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" style="max-height:400px">
      <div class="sheet-handle"></div>
      <div class="datepick-nav-row">
        <button class="datepick-nav" id="dp-prev">‹</button>
        <span class="datepick-month-label" id="dp-label"></span>
        <button class="datepick-nav" id="dp-next">›</button>
      </div>
      <div class="datepick-weekdays">
        ${['M','T','W','T','F','S','S'].map(d => `<div>${d}</div>`).join('')}
      </div>
      <div class="datepick-grid" id="dp-grid"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  function render() {
    const firstDow = new Date(viewY, viewM - 1, 1).getDay();
    const startOffset = (firstDow + 6) % 7;
    const daysInMonth = new Date(viewY, viewM, 0).getDate();
    const label = new Date(viewY, viewM - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    overlay.querySelector('#dp-label').textContent = label;
    const cells = Array(startOffset).fill(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    overlay.querySelector('#dp-grid').innerHTML = cells.map(d => {
      if (!d) return '<div></div>';
      const ds = `${viewY}-${String(viewM).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const sel = ds === currentDate ? 'selected' : '';
      const dis = ds > maxDate ? 'disabled' : '';
      return `<button class="datepick-day ${sel} ${dis}" data-date="${ds}" ${dis}>${d}</button>`;
    }).join('');
    overlay.querySelector('#dp-prev').disabled = viewY <= 2010 && viewM <= 1;
    const nextM = viewM === 12 ? 1 : viewM + 1;
    const nextY = viewM === 12 ? viewY + 1 : viewY;
    overlay.querySelector('#dp-next').disabled = `${nextY}-${String(nextM).padStart(2,'0')}-01` > maxDate;
  }
  render();

  overlay.querySelector('#dp-prev').onclick = () => { viewM--; if (viewM < 1) { viewM = 12; viewY--; } render(); };
  overlay.querySelector('#dp-next').onclick = () => { viewM++; if (viewM > 12) { viewM = 1; viewY++; } render(); };
  delegate(overlay, 'click', '.datepick-day:not([disabled])', (e, el) => {
    currentDate = el.dataset.date;
    onSelect(currentDate);
    overlay.remove();
  });
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
}

function openCategoryPicker(cats, currentCatId, onSelect) {
  const pickerOverlay = document.createElement('div');
  pickerOverlay.className = 'sheet-overlay';
  pickerOverlay.innerHTML = `
    <div class="sheet" style="max-height:70vh">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Category</span>
        <button class="sheet-close" id="cat-pick-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:12px;overflow-y:auto">
        <div class="cat-grid" style="display:grid">
          ${cats.map(c => `
            <div class="cat-item ${currentCatId === c.id ? 'selected' : ''}"
                 data-cat="${c.id}" data-cat-name="${c.name}" data-cat-icon="${c.icon}">
              <div class="cat-icon" style="background:${c.colour}20;color:${c.colour}">${c.icon}</div>
              <div class="cat-name">${c.name}</div>
            </div>
          `).join('')}
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(pickerOverlay);
  pickerOverlay.querySelector('#cat-pick-close').onclick = () => pickerOverlay.remove();
  pickerOverlay.onclick = e => { if (e.target === pickerOverlay) pickerOverlay.remove(); };
  delegate(pickerOverlay, 'click', '.cat-item', (e, el) => {
    const catId = el.dataset.cat ? Number(el.dataset.cat) : null;
    onSelect(catId, el.dataset.catName, el.dataset.catIcon);
    pickerOverlay.remove();
  });
}

async function setupNoteAutocomplete(overlay) {
  const noteInput = overlay.querySelector('#entry-note');
  const suggestEl = overlay.querySelector('#note-suggestions');
  if (!noteInput || !suggestEl || !state.entryCategory) return;

  const cutoff = addDays(today(), -365);
  const pastTxns = await db.transactions
    .filter(t => t.categoryId === state.entryCategory && t.note && t.note.trim() && t.date >= cutoff)
    .toArray();
  const freq = {};
  for (const t of pastTxns) { const n = t.note.trim(); freq[n] = (freq[n] ?? 0) + 1; }
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([n]) => n);

  function refresh() {
    const q = noteInput.value.toLowerCase();
    const matches = q ? sorted.filter(n => n.toLowerCase().startsWith(q)) : sorted.slice(0, 6);
    suggestEl.innerHTML = matches.slice(0, 6).map(n =>
      `<button class="note-chip" data-note="${n.replace(/"/g,'&quot;')}">${n}</button>`
    ).join('');
  }

  noteInput.addEventListener('focus', refresh);
  const existingInput = noteInput.oninput;
  noteInput.oninput = e => { state.entryNote = e.target.value; refresh(); };
  delegate(suggestEl, 'click', '.note-chip', (e, el) => {
    noteInput.value = el.dataset.note;
    state.entryNote = el.dataset.note;
    suggestEl.innerHTML = '';
    noteInput.blur();
  });
  refresh();
}

function closeEntry() {
  const overlay = document.getElementById('entry-overlay');
  if (overlay) overlay.remove();
}

async function saveEntry(overlay) {
  const amount = state.entryPence / 100;
  if (!amount || amount <= 0) { showToast('Enter an amount'); return; }
  // Auto-assign Misc category for expenses if none selected
  if (!state.entryCategory && state.entryType === 'expense') state.entryCategory = 28;

  const finalAmount = state.entryType === 'expense' ? -amount : amount;
  const txn = {
    date: state.entryDate, amount: finalAmount, categoryId: state.entryCategory,
    note: state.entryNote.trim(), type: state.entryType, distributionId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), syncStatus: 'pending',
  };

  if (state.entryEditId) {
    await db.transactions.update(state.entryEditId, { ...txn, updatedAt: new Date().toISOString() });
    await queueWrite('transactions', state.entryEditId);
    showToast('Transaction updated');
  } else {
    const newId = await db.transactions.add(txn);
    await queueWrite('transactions', newId);
    showToast('Saved');
  }

  closeEntry();
  if (state.view === 'balance') await renderBalance();
  else if (state.view === 'transactions') await renderTransactions();
}

async function renderTransactions() {
  const monthKey = state.txnMonth ?? today().slice(0, 7);
  const [yyyy, mm] = monthKey.split('-').map(Number);
  const monthStart = `${yyyy}-${String(mm).padStart(2, '0')}-01`;
  const lastDay = new Date(yyyy, mm, 0).getDate();
  const monthEnd = `${yyyy}-${String(mm).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  const monthLabel = new Date(yyyy, mm - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const { dailyAllowance } = await calcDailyAllowance(monthStart, monthEnd);

  const query = state.txnSearchQuery.toLowerCase();
  const searchAll = state.txnSearchAll && query.length > 0;

  let txns;
  if (searchAll) {
    txns = await db.transactions
      .filter(t => ['expense', 'income', 'distributed_expense', 'distributed_income'].includes(t.type))
      .toArray();
  } else {
    txns = await db.transactions
      .where('date').between(monthStart, monthEnd, true, true)
      .filter(t => ['expense', 'income', 'distributed_expense', 'distributed_income'].includes(t.type))
      .toArray();
  }
  txns.sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  if (query) txns = txns.filter(t => t.note?.toLowerCase().includes(query));

  const cats = await db.categories.toArray();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

  // Rolling balance to end of month (or today if month is current/future)
  const effectiveDate = today() < monthEnd ? today() : monthEnd;
  const { balance: monthTotal } = await calcRollingBalance(effectiveDate);

  const groups = {};
  for (const t of txns) {
    if (!groups[t.date]) groups[t.date] = [];
    groups[t.date].push(t);
  }

  let dates;
  if (searchAll) {
    // Only show dates that have matching transactions
    dates = [...new Set(txns.map(t => t.date))].sort().reverse();
  } else {
    // Show every day up to today (or month end)
    const showUntil = today() < monthEnd ? today() : monthEnd;
    const allDates = [];
    let dayCursor = monthStart;
    while (dayCursor <= showUntil) { allDates.push(dayCursor); dayCursor = addDays(dayCursor, 1); }
    allDates.reverse();
    dates = query ? allDates.filter(d => groups[d]?.length > 0) : allDates;
  }

  const budgetRow = `
    <div class="txn-row txn-row-budget">
      <div class="txn-cat-icon" style="background:#2b82e820">💵</div>
      <div class="txn-info">
        <div class="txn-note">Daily Budget</div>
        <div class="txn-cat-name">Allowance</div>
      </div>
      <div class="txn-amount positive">+${fmt(dailyAllowance)}</div>
    </div>
  `;

  viewContainer.innerHTML = `
    <div class="transactions-screen">
      <div class="screen-header">
        <div style="width:36px"></div>
        <span class="screen-title">Transactions</span>
        <button class="icon-btn" id="txn-add-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      ${!searchAll ? `<button id="month-picker-btn" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--card);border:none;border-bottom:1px solid var(--border);width:100%;cursor:pointer;font-size:15px;color:var(--text)">
        <span style="font-weight:500">${monthLabel}</span>
        <span style="display:flex;align-items:center;gap:6px;color:var(--text-2);font-size:13px">
          ${txns.length > 0 ? `<span style="color:${monthTotal >= 0 ? 'var(--green)' : 'var(--red)'}">${monthTotal >= 0 ? '+' : ''}${fmt(monthTotal)}</span>` : ''}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </button>` : `<div style="padding:8px 16px;font-size:13px;color:var(--text-2);background:var(--card);border-bottom:1px solid var(--border)">Searching all transactions (${txns.length} found)</div>`}
      <div class="search-bar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="txn-search" placeholder="Search transactions..." value="${state.txnSearchQuery}" style="flex:1;border:none;outline:none;font-size:15px;background:none" autocomplete="off" autocorrect="off" autocapitalize="off">
        <label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--text-2);white-space:nowrap;cursor:pointer;padding-left:6px">
          <input type="checkbox" id="txn-search-all" ${state.txnSearchAll ? 'checked' : ''} style="accent-color:var(--blue)"> All
        </label>
      </div>
      <div id="txn-list-body">
        ${dates.length === 0 ? `
          <div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">No transactions in ${monthLabel}</div><div class="empty-text">Tap + to add a transaction</div></div>
        ` : dates.map(date => {
          const dayTxns = groups[date] ?? [];
          const dayTotal = dayTxns.reduce((s, t) => s + t.amount, dailyAllowance);
          const d = new Date(date + 'T12:00:00');
          const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
          return `
            <div class="day-group">
              <div class="day-header">
                <span>${dayLabel}</span>
                <button class="day-add-btn" data-date="${date}">+</button>
              </div>
              <div class="txn-list">
                ${!searchAll ? budgetRow : ''}
                ${dayTxns.map(t => {
                  const cat = catMap[t.categoryId];
                  const sign = t.amount >= 0 ? '+' : '';
                  return `
                    <div class="txn-row" data-txn-id="${t.id}">
                      <div class="txn-cat-icon" style="background:${cat?.colour ?? '#ccc'}20">${cat?.icon ?? '📦'}</div>
                      <div class="txn-info">
                        <div class="txn-note">${t.note || cat?.name || 'Transaction'}</div>
                        <div class="txn-cat-name">${cat?.name ?? ''}</div>
                      </div>
                      <div class="txn-amount ${t.amount >= 0 ? 'positive' : 'negative'}">${sign}${fmt(Math.abs(t.amount))}</div>
                      <div class="txn-delete-zone">Delete</div>
                    </div>
                  `;
                }).join('')}
              </div>
              ${!searchAll ? `<div class="day-total"><div class="day-total-amount ${dayTotal < 0 ? 'negative' : ''}">${fmt(dayTotal)}</div></div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  const txnScreen = viewContainer.querySelector('.transactions-screen');
  txnScreen.querySelector('#txn-add-btn').onclick = () => openEntry('expense');
  let _searchTimer;
  txnScreen.querySelector('#txn-search').addEventListener('input', e => {
    state.txnSearchQuery = e.target.value;
    clearTimeout(_searchTimer);
    _searchTimer = setTimeout(async () => {
      await renderTransactions();
      const inp = viewContainer.querySelector('#txn-search');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 250);
  });
  txnScreen.querySelector('#txn-search-all').addEventListener('change', e => {
    state.txnSearchAll = e.target.checked;
    renderTransactions();
  });
  txnScreen.querySelector('#month-picker-btn')?.addEventListener('click', () => showMonthPicker());
  delegate(txnScreen, 'click', '.txn-row:not([data-swiped])', async (e, el) => {
    if (!el.dataset.txnId) return;
    const id = Number(el.dataset.txnId);
    const txn = await db.transactions.get(id);
    if (!txn) return;
    if (txn.distributionId) {
      const dist = await db.distributions.get(txn.distributionId);
      if (dist) { openDistEditor(dist.id, !!dist.isIncome); return; }
    }
    openEntry(txn.amount >= 0 ? 'income' : 'expense', txn);
  });
  delegate(txnScreen, 'click', '.txn-delete-zone', async (e, el) => {
    e.stopPropagation();
    const row = el.closest('.txn-row');
    const id = Number(row?.dataset.txnId);
    if (!id) return;
    await db.transactions.delete(id);
    await queueDelete('transactions', id);
    renderTransactions();
  });
  delegate(txnScreen, 'click', '.day-add-btn', (e, el) => { state.entryDate = el.dataset.date; openEntry('expense'); });
  addSwipeToDelete(txnScreen);
}

async function showMonthPicker() {
  const firstTxn = await db.transactions.orderBy('date').first();
  const earliestMonth = firstTxn ? firstTxn.date.slice(0, 7) : today().slice(0, 7);
  const currentKey = state.txnMonth ?? today().slice(0, 7);
  const todayStr = today();

  // Generate every month from earliest to now
  const months = [];
  let [ey, em] = earliestMonth.split('-').map(Number);
  const [cy, cm] = todayStr.slice(0, 7).split('-').map(Number);
  while (ey < cy || (ey === cy && em <= cm)) {
    months.push(`${ey}-${String(em).padStart(2, '0')}`);
    em++; if (em > 12) { em = 1; ey++; }
  }
  months.reverse();

  // Compute rolling balance (budget left) for each month — the single source of truth
  const balances = await Promise.all(months.map(async mk => {
    const [y, m] = mk.split('-').map(Number);
    const monthEnd = `${y}-${String(m).padStart(2,'0')}-${String(new Date(y, m, 0).getDate()).padStart(2,'0')}`;
    const effectiveDate = todayStr < monthEnd ? todayStr : monthEnd;
    const { balance } = await calcRollingBalance(effectiveDate);
    return balance;
  }));

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" style="max-height:80vh">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Select Month</span>
        <button class="sheet-close" id="month-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:0;overflow-y:auto">
        ${months.map((mk, idx) => {
          const [y, m] = mk.split('-').map(Number);
          const label = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
          const bal = balances[idx];
          const isSel = mk === currentKey;
          return `<div class="settings-row month-pick-row" data-month="${mk}" style="${isSel ? 'color:var(--blue)' : ''}">
            <span style="flex:1;font-size:15px">${label}</span>
            <span style="font-size:13px;color:${bal >= 0 ? 'var(--green)' : 'var(--red)'}">Budget left: ${fmt(bal)}</span>
            ${isSel ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--blue)" stroke-width="2.5" style="margin-left:8px"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
          </div>`;
        }).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#month-close').onclick = () => overlay.remove();
  delegate(overlay, 'click', '.month-pick-row', (e, el) => {
    state.txnMonth = el.dataset.month;
    overlay.remove();
    renderTransactions();
  });
}

async function showTxnMenu(id) {
  const txn = await db.transactions.get(id);
  if (!txn) return;
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">${txn.note || 'Transaction'}</span>
        <button class="sheet-close" id="txn-menu-close">✕</button>
      </div>
      <div class="modal-body" style="text-align:center;padding:20px">
        <div style="font-size:32px;font-weight:200;margin-bottom:8px">${fmt(txn.amount)}</div>
        <div style="color:var(--text-2);font-size:14px">${fmtDate(txn.date)}</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="txn-edit-btn">Edit</button>
        <button class="btn btn-danger" id="txn-del-btn">Delete</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.querySelector('#txn-menu-close').onclick = () => overlay.remove();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#txn-edit-btn').onclick = async () => {
    overlay.remove();
    if (txn.distributionId) {
      const dist = await db.distributions.get(txn.distributionId);
      if (dist) { openDistEditor(dist.id, !!dist.isIncome); return; }
    }
    openEntry(txn.amount >= 0 ? 'income' : 'expense', txn);
  };
  overlay.querySelector('#txn-del-btn').onclick = async () => {
    if (txn.distributionId) { showToast('Open the parent Big Expense or Extra Income to delete'); overlay.remove(); return; }
    await db.transactions.delete(id);
    await queueDelete('transactions', id);
    overlay.remove();
    showToast('Deleted');
    renderTransactions();
  };
}

async function renderBreakdown() {
  if (!state.viewingCycle) state.viewingCycle = await getCurrentCycle();
  const cycle = state.viewingCycle;
  const bd = await getCycleBreakdown(cycle.start, cycle.end);

  const cycleLen = diffDays(cycle.start, cycle.end) + 1;

  const rows = [
    { icon: '💰', bg: '#e8f5e9', label: 'Income', amount: bd.totalIncome, daily: bd.regularIncome / cycleLen, amountClass: 'text-green',
      subs: [{ label: 'Regular income', amount: bd.regularIncome }, { label: 'Extra income', amount: bd.variableIncome }] },
    { icon: '🛒', bg: '#ffebee', label: 'Expenses', amount: bd.totalExpenses, daily: bd.recurringExpenses / cycleLen, amountClass: 'text-red',
      subs: [{ label: 'Recurring expenses', amount: bd.recurringExpenses }, { label: 'Variable expenses', amount: bd.variableExpenses }, { label: 'Big Expenses', amount: bd.distributionExpenses }] },
    { icon: '💛', bg: '#fffde7', label: 'Savings', amount: bd.savings, daily: bd.savings / cycleLen, amountClass: '', subs: [] },
    { icon: '📊', bg: '#e3f2fd', label: 'Budget left', amount: bd.budgetLeft, daily: null, amountClass: bd.budgetLeft >= 0 ? 'text-green' : 'text-red', subs: [] },
  ];

  viewContainer.innerHTML = `
    <div class="breakdown-screen">
      <div class="screen-header">
        <button class="icon-btn" onclick="window.app.navigate('balance')">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="screen-title">Daily Budget</span>
        <div style="width:34px"></div>
      </div>
      <div class="breakdown-cycle-nav">
        <button class="cycle-nav-btn" id="cycle-prev">&lt;</button>
        <span class="cycle-label">${fmtDate(cycle.start)} - ${fmtDate(cycle.end)}</span>
        <button class="cycle-nav-btn" id="cycle-next">&gt;</button>
      </div>
      <div style="padding:8px 12px 4px;font-size:12px;color:var(--text-2);text-align:center">
        Daily allowance: <strong>${fmt(bd.dailyAllowance)}/day</strong>
      </div>
      <div class="breakdown-card">
        ${rows.map(row => `
          <div>
            <div class="breakdown-row">
              <div class="breakdown-row-icon" style="background:${row.bg}">${row.icon}</div>
              <div class="breakdown-row-info"><div class="breakdown-row-label">${row.label}</div></div>
              <div class="breakdown-row-amount ${row.amountClass}">
                ${fmt(Math.abs(row.amount))}
                ${row.daily != null ? `<div style="font-size:11px;font-weight:400;color:var(--text-2)">${fmt(Math.abs(row.daily))}/day</div>` : ''}
              </div>
            </div>
            ${row.subs.filter(s => s.amount !== 0).map(s => `
              <div class="breakdown-sub-rows">
                <div class="breakdown-sub-row">
                  <span class="breakdown-sub-label">${s.label}</span>
                  <span class="breakdown-sub-amount">
                    ${fmt(Math.abs(s.amount))}
                    ${s.daily != null ? `<span style="font-size:10px;color:var(--text-2);margin-left:4px">${fmt(Math.abs(s.daily))}/d</span>` : ''}
                  </span>
                </div>
              </div>
            `).join('')}
          </div>
        `).join('')}
      </div>
      <div style="padding:0 12px 16px">
        <button class="btn btn-primary btn-full" onclick="window.app.navigate('recurring')">View recurring expenses</button>
      </div>
    </div>
  `;

  viewContainer.querySelector('#cycle-prev').onclick = () => {
    const [y, m] = cycle.start.split('-').map(Number);
    state.viewingCycle = cycleForDate(isoDate(new Date(y, m - 2, 1)));
    renderBreakdown();
  };
  viewContainer.querySelector('#cycle-next').onclick = () => {
    const [y, m] = cycle.start.split('-').map(Number);
    const nextStr = isoDate(new Date(y, m, 1));
    if (nextStr > today()) return;
    state.viewingCycle = cycleForDate(nextStr);
    renderBreakdown();
  };
}

async function renderRecurring() {
  const tab = state.recurringTab;
  if (!state.recurringCycle) state.recurringCycle = await getCurrentCycle();
  const cycle = state.recurringCycle;
  const cycleLen = diffDays(cycle.start, cycle.end) + 1;
  const isCurrentCycle = cycle.start === (await getCurrentCycle()).start;

  const activeFilter = r => r.startDate <= cycle.end && (r.endDate == null || r.endDate === '4001-01-01' || r.endDate >= cycle.start);
  let items;
  if (tab === 'expenses') {
    items = (await db.recurringExpenses.toArray()).filter(activeFilter);
  } else {
    items = (await db.recurringIncome.toArray()).filter(activeFilter);
  }

  // Pro-rate each item by how many days it overlaps the selected cycle
  function proratedRate(r) {
    const effStart = r.startDate > cycle.start ? r.startDate : cycle.start;
    const effEnd = (!r.endDate || r.endDate === '4001-01-01' || r.endDate > cycle.end) ? cycle.end : r.endDate;
    const overlap = Math.max(0, diffDays(effStart, effEnd) + 1);
    return dailyEquivalent(r.amount ?? 0, r.frequency ?? 'monthly', cycleLen) * overlap / cycleLen;
  }

  items.sort((a, b) => proratedRate(b) - proratedRate(a));

  const totalDaily = items.reduce((s, r) => s + proratedRate(r), 0);
  const totalMonthly = totalDaily * cycleLen;

  const cycleLabel = new Date(cycle.start + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  const formatMeta = r => {
    const start = r.startDate ? fmtDate(r.startDate) : '-';
    const end = (!r.endDate || r.endDate === '4001-01-01') ? 'open end' : fmtDate(r.endDate);
    const freq = (r.frequency ?? 'monthly').charAt(0).toUpperCase() + (r.frequency ?? 'monthly').slice(1);
    return `${fmt(r.amount)} (${freq}) ${start} – ${end}`;
  };

  const heroColor = tab === 'income' ? 'linear-gradient(160deg,#2b82e8 0%,#4db8f7 100%)' : 'linear-gradient(160deg,var(--coral) 0%,var(--coral-light) 100%)';
  const tabBg = tab === 'income' ? '#2b82e8' : 'var(--coral)';
  viewContainer.innerHTML = `
    <div class="recurring-screen">
      <div class="recurring-hero" style="background:${heroColor};position:relative">
        <button class="icon-btn" onclick="window.app.navigate('settings')" style="position:absolute;top:52px;left:12px;color:white;opacity:0.9">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="recurring-hero-icon">${tab === 'expenses' ? '🏠' : '💵'}</div>
        <div class="recurring-hero-total">Total</div>
        <div class="recurring-hero-amount">${fmt(totalDaily)}<span style="font-size:16px;opacity:0.7"> /day</span></div>
        <div style="font-size:13px;opacity:0.8">${fmt(totalMonthly)}/month</div>
        <div class="breakdown-cycle-nav" style="background:rgba(0,0,0,0.15);border-radius:20px;margin:8px auto 0;width:fit-content;padding:2px 4px">
          <button class="cycle-nav-btn" id="rec-cycle-prev" style="color:white;opacity:0.9">&lt;</button>
          <span style="color:white;font-size:13px;min-width:130px;text-align:center">${cycleLabel}</span>
          <button class="cycle-nav-btn" id="rec-cycle-next" style="color:white;opacity:0.9;visibility:${isCurrentCycle ? 'hidden' : 'visible'}">&gt;</button>
        </div>
      </div>
      <div class="tab-bar" style="background:${tabBg};border-bottom:none;padding:0 12px 12px">
        <button class="chip ${tab === 'expenses' ? 'active' : ''}" id="tab-exp"
                style="${tab === 'expenses' ? 'background:rgba(255,255,255,0.3);border-color:rgba(255,255,255,0.6);color:white' : 'background:rgba(0,0,0,0.1);border-color:rgba(255,255,255,0.3);color:rgba(255,255,255,0.8)'}">
          Expenses
        </button>
        <button class="chip ${tab === 'income' ? 'active' : ''}" id="tab-inc"
                style="${tab === 'income' ? 'background:rgba(255,255,255,0.3);border-color:rgba(255,255,255,0.6);color:white' : 'background:rgba(0,0,0,0.1);border-color:rgba(255,255,255,0.3);color:rgba(255,255,255,0.8)'}">
          Income
        </button>
      </div>
      <div class="recurring-list">
        <button class="btn btn-primary btn-full" id="rec-add-btn" style="margin-bottom:8px">+ Add ${tab === 'expenses' ? 'expense' : 'income'}</button>
        ${items.length === 0 ? `
          <div class="empty-state" style="padding-top:8px"><div class="empty-icon">${tab === 'expenses' ? '💸' : '💰'}</div><div class="empty-title">No active ${tab}</div><div class="empty-text">Tap + above to add one</div></div>
        ` : items.map(r => `
          <div class="recurring-card" data-rec-id="${r.id}" data-rec-type="${tab}">
            <div class="recurring-card-info">
              <div class="recurring-card-name">${r.description}</div>
              <div class="recurring-card-meta">${formatMeta(r)}</div>
            </div>
            <div class="recurring-card-amount">
              <div class="recurring-card-daily">${fmt(proratedRate(r))}<span style="font-size:14px;font-weight:400"> /day</span></div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const recScreen = viewContainer.firstElementChild;
  recScreen.querySelector('#tab-exp').onclick = () => { state.recurringTab = 'expenses'; renderRecurring(); };
  recScreen.querySelector('#tab-inc').onclick = () => { state.recurringTab = 'income'; renderRecurring(); };
  recScreen.querySelector('#rec-cycle-prev').onclick = () => {
    const [y, m] = cycle.start.split('-').map(Number);
    state.recurringCycle = cycleForDate(isoDate(new Date(y, m - 2, 1)));
    renderRecurring();
  };
  recScreen.querySelector('#rec-cycle-next').onclick = () => {
    const [y, m] = cycle.start.split('-').map(Number);
    const next = isoDate(new Date(y, m, 1));
    if (next <= today()) { state.recurringCycle = cycleForDate(next); renderRecurring(); }
  };
  recScreen.querySelector('#rec-add-btn').onclick = () => openRecurringEditor(null, tab);
  delegate(recScreen, 'click', '.recurring-card', (e, el) => openRecurringEditor(Number(el.dataset.recId), el.dataset.recType));
}

async function openRecurringEditor(id, type) {
  const isExpense = type === 'expenses';
  let item = id ? (isExpense ? await db.recurringExpenses.get(id) : await db.recurringIncome.get(id)) : null;
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${item ? 'Edit' : 'Add'} ${isExpense ? 'Recurring Expense' : 'Recurring Income'}</span>
        <button class="sheet-close" id="rec-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="rec-desc" type="text" value="${item?.description ?? ''}" placeholder="e.g. Netflix"></div>
        <div class="form-group"><label class="form-label">Amount (£)</label><input class="form-input" id="rec-amount" type="number" step="0.01" min="0" value="${item?.amount ?? ''}" placeholder="0.00"></div>
        <div class="form-group"><label class="form-label">Frequency</label><select class="form-select" id="rec-freq"><option value="monthly" ${(item?.frequency ?? 'monthly') === 'monthly' ? 'selected' : ''}>Monthly</option><option value="yearly" ${item?.frequency === 'yearly' ? 'selected' : ''}>Yearly</option><option value="quarterly" ${item?.frequency === 'quarterly' ? 'selected' : ''}>Quarterly</option></select></div>
        <div class="form-group"><label class="form-label">Start date</label><input class="form-input" id="rec-start" type="date" value="${item?.startDate ?? today()}"></div>
        <div class="form-group"><label class="form-label">End date (leave blank for open-ended)</label><input class="form-input" id="rec-end" type="date" value="${(!item?.endDate || item.endDate === '4001-01-01') ? '' : item.endDate}"></div>
        <div style="display:flex;gap:8px;padding-bottom:20px">
          ${item ? `<button class="btn btn-danger" id="rec-del">Delete</button>` : ''}
          <button class="btn btn-primary" id="rec-save" style="flex:1">${item ? 'Update' : 'Save'}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#rec-close').onclick = () => overlay.remove();
  if (item) {
    overlay.querySelector('#rec-del').onclick = async () => {
      if (!confirm('Delete this item?')) return;
      if (isExpense) { await db.recurringExpenses.delete(id); await queueDelete('recurringExpenses', id); }
      else { await db.recurringIncome.delete(id); await queueDelete('recurringIncome', id); }
      overlay.remove(); renderRecurring();
    };
  }
  overlay.querySelector('#rec-save').onclick = async () => {
    const desc = overlay.querySelector('#rec-desc').value.trim();
    const amount = parseFloat(overlay.querySelector('#rec-amount').value);
    const start = overlay.querySelector('#rec-start').value;
    const end = overlay.querySelector('#rec-end').value || '4001-01-01';
    if (!desc || isNaN(amount)) { showToast('Fill in description and amount'); return; }
    const freq = overlay.querySelector('#rec-freq').value;
    if (isExpense) {
      const shared = item?.isShared ?? false;
      const data = { description: desc, amount, frequency: freq, isShared: shared, sharePercent: 50, startDate: start, endDate: end, isActive: true };
      if (id) { await db.recurringExpenses.update(id, data); await queueWrite('recurringExpenses', id); }
      else { const newId = await db.recurringExpenses.add(data); await queueWrite('recurringExpenses', newId); }
    } else {
      const data = { description: desc, amount, frequency: freq, startDate: start, endDate: end, isActive: true };
      if (id) { await db.recurringIncome.update(id, data); await queueWrite('recurringIncome', id); }
      else { const newId = await db.recurringIncome.add(data); await queueWrite('recurringIncome', newId); }
    }
    overlay.remove(); renderRecurring(); showToast(id ? 'Updated' : 'Saved');
  };
}

async function renderAnalysis() {
  const todayStr = today();

  // Determine which cycle to view
  if (!state.analysisViewingCycle) state.analysisViewingCycle = await getCurrentCycle();
  const cycle = state.analysisViewingCycle;
  const isCurrentCycle = cycle.end >= todayStr;

  // Fetch current cycle transactions (all types for daily totals, expenses for category analysis)
  const cycleTxns = await db.transactions
    .where('date').between(cycle.start, cycle.end, true, true)
    .toArray();

  const cats = await db.categories.toArray();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

  // Daily totals for surplus/loss chart and rolling balance
  const cutoffDate = isCurrentCycle ? todayStr : cycle.end;
  const days = [];
  let dCur = cycle.start;
  while (dCur <= cutoffDate) { days.push(dCur); dCur = addDays(dCur, 1); }

  const { dailyAllowance } = await calcDailyAllowance(cycle.start, cycle.end);
  const dailyByDate = {};
  for (const t of cycleTxns) {
    if (!dailyByDate[t.date]) dailyByDate[t.date] = 0;
    dailyByDate[t.date] += t.amount;
  }

  // Rolling balance: cumulative (dailyAllowance + net spend each day)
  const rollingData = [];
  let runningBal = 0;
  for (const day of days) {
    runningBal += dailyAllowance + (dailyByDate[day] ?? 0);
    rollingData.push({ day, balance: runningBal });
  }

  // Daily surplus/loss: allowance + net for that day
  const surplusData = days.map(day => ({
    day,
    value: dailyAllowance + (dailyByDate[day] ?? 0),
  }));

  // Category spending this cycle
  const expenseTxns = cycleTxns.filter(t => t.type === 'expense' || t.type === 'distributed_expense');
  const byCat = {};
  let totalSpend = 0;
  for (const t of expenseTxns) {
    if (!byCat[t.categoryId]) byCat[t.categoryId] = 0;
    byCat[t.categoryId] += Math.abs(t.amount);
    totalSpend += Math.abs(t.amount);
  }
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 12);

  // Previous cycle for comparison
  const prevCycleStart = addDays(cycle.start, -1);
  const prevCycle = await getCycleForDate(prevCycleStart);
  let prevByCat = {};
  let avgByCat = {};

  if (prevCycle) {
    const prevTxns = await db.transactions
      .where('date').between(prevCycle.start, prevCycle.end, true, true)
      .filter(t => t.type === 'expense' || t.type === 'distributed_expense')
      .toArray();
    for (const t of prevTxns) {
      if (!prevByCat[t.categoryId]) prevByCat[t.categoryId] = 0;
      prevByCat[t.categoryId] += Math.abs(t.amount);
    }
  }

  // 12-month average by category
  const avg12Months = [];
  for (let i = 1; i <= 12; i++) {
    const dt = new Date(cycle.start + 'T12:00:00');
    dt.setMonth(dt.getMonth() - i);
    const ms = isoDate(new Date(dt.getFullYear(), dt.getMonth(), 1));
    const me = isoDate(new Date(dt.getFullYear(), dt.getMonth() + 1, 0));
    avg12Months.push({ start: ms, end: me });
  }
  const avg12Txns = await db.transactions
    .where('date').between(avg12Months[11].start, avg12Months[0].end, true, true)
    .filter(t => t.type === 'expense' || t.type === 'distributed_expense')
    .toArray();
  const avg12ByCatMonth = {};
  for (const t of avg12Txns) {
    const m = t.date.slice(0, 7);
    if (!avg12ByCatMonth[t.categoryId]) avg12ByCatMonth[t.categoryId] = {};
    if (!avg12ByCatMonth[t.categoryId][m]) avg12ByCatMonth[t.categoryId][m] = 0;
    avg12ByCatMonth[t.categoryId][m] += Math.abs(t.amount);
  }
  for (const [cid, months] of Object.entries(avg12ByCatMonth)) {
    const vals = Object.values(months);
    avgByCat[cid] = vals.reduce((s, v) => s + v, 0) / 12;
  }

  // Month-on-month: last 6 cycles
  const momMonths = [];
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(cycle.start + 'T12:00:00');
    dt.setMonth(dt.getMonth() - i);
    const ms = isoDate(new Date(dt.getFullYear(), dt.getMonth(), 1));
    const me = isoDate(new Date(dt.getFullYear(), dt.getMonth() + 1, 0));
    const mTxns = await db.transactions
      .where('date').between(ms, me, true, true)
      .filter(t => t.type === 'expense' || t.type === 'distributed_expense')
      .toArray();
    momMonths.push({
      label: dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
      total: mTxns.reduce((s, t) => s + Math.abs(t.amount), 0),
    });
  }

  const compareMode = state.analysisCatCompare;
  const cycleLabel = new Date(cycle.start + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });

  viewContainer.innerHTML = `
    <div class="analysis-screen">
      <div class="screen-header" style="padding-top:52px">
        <button class="icon-btn" id="analysis-prev">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="screen-title">${cycleLabel}</span>
        <button class="icon-btn" id="analysis-next" ${isCurrentCycle ? 'style="opacity:.3;pointer-events:none"' : ''}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
      <div class="analysis-section">
        <div class="analysis-section-title">Rolling balance</div>
        <div class="chart-wrap"><canvas id="chart-balance"></canvas></div>
      </div>
      <div class="analysis-section">
        <div class="analysis-section-title">Daily surplus / loss</div>
        <div class="chart-wrap"><canvas id="chart-surplus"></canvas></div>
      </div>
      <div class="analysis-section">
        <div class="analysis-section-title">Spending by category
          <span style="float:right;display:flex;gap:4px">
            <button class="pill-btn ${compareMode === 'lastMonth' ? 'active' : ''}" id="compare-last">vs last month</button>
            <button class="pill-btn ${compareMode === 'avg12' ? 'active' : ''}" id="compare-avg">vs 12m avg</button>
          </span>
        </div>
        ${catRows.length === 0 ? '<div class="empty-state" style="padding:20px 0"><div class="empty-text">No spending data yet</div></div>' : ''}
        ${catRows.map(([cid, total]) => {
          const cat = catMap[cid];
          const pct = totalSpend > 0 ? (total / totalSpend * 100) : 0;
          const compareVal = compareMode === 'lastMonth' ? (prevByCat[cid] ?? 0) : (avgByCat[cid] ?? 0);
          const diff = total - compareVal;
          const diffStr = compareVal > 0
            ? `<span style="font-size:12px;font-weight:600;color:${diff > 0 ? '#e53935' : '#43a047'}">${diff > 0 ? '+' : ''}${fmt(diff)}</span>`
            : `<span style="font-size:12px;color:var(--text-2)">—</span>`;
          return `<div class="cat-bar-row">
            <span class="cat-dot" style="background:${cat?.colour ?? '#ccc'}"></span>
            <span class="cat-bar-label">${cat?.icon ?? ''} ${cat?.name ?? 'Other'}</span>
            <span class="cat-bar-diff">${diffStr}</span>
            <span class="cat-bar-amount">${fmt(total)}</span>
          </div>`;
        }).join('')}
        ${totalSpend > 0 ? `<div style="text-align:right;margin-top:8px;font-size:13px;color:var(--text-2)">Total: <strong>${fmt(totalSpend)}</strong></div>` : ''}
      </div>
      <div class="analysis-section" style="margin-bottom:80px">
        <div class="analysis-section-title">Monthly variable spending (last 6 months)</div>
        <div class="chart-wrap"><canvas id="chart-mom"></canvas></div>
      </div>
    </div>
  `;

  // Rolling balance chart — consistent y-axis intervals
  const balValues = rollingData.map(d => d.balance);
  const balRawMin = Math.min(...balValues);
  const balRawMax = Math.max(...balValues);
  const balNiceSteps = [5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
  const balRange = balRawMax - balRawMin;
  const balStep = balNiceSteps.find(s => balRange / s <= 7) ?? 5000;
  const balMin = Math.floor(balRawMin / balStep) * balStep;
  const balMax = Math.ceil(balRawMax / balStep) * balStep;
  const yTick = v => Math.abs(v) >= 1000 ? `£${(v/1000).toFixed(1)}k` : `£${v.toFixed(0)}`;

  new Chart(viewContainer.querySelector('#chart-balance').getContext('2d'), {
    type: 'line',
    data: {
      labels: rollingData.map(d => new Date(d.day + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
      datasets: [{
        data: rollingData.map(d => d.balance),
        borderColor: '#1a73e8',
        backgroundColor: 'rgba(26,115,232,0.1)',
        borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 6, font: { size: 11 } } },
        y: {
          min: balMin, max: balMax,
          grid: { color: 'rgba(0,0,0,0.06)' },
          ticks: { stepSize: balStep, font: { size: 11 }, callback: yTick },
        },
      },
    },
  });

  // Surplus/loss bar chart — blue positive, orange negative
  new Chart(viewContainer.querySelector('#chart-surplus').getContext('2d'), {
    type: 'bar',
    data: {
      labels: surplusData.map(d => new Date(d.day + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric' })),
      datasets: [{
        data: surplusData.map(d => d.value),
        backgroundColor: surplusData.map(d => d.value >= 0 ? 'rgba(26,115,232,0.75)' : 'rgba(239,108,0,0.75)'),
        borderRadius: 3,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 10, font: { size: 10 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 11 }, callback: yTick } },
      },
    },
  });

  // Month-on-month bar chart
  new Chart(viewContainer.querySelector('#chart-mom').getContext('2d'), {
    type: 'bar',
    data: {
      labels: momMonths.map(m => m.label),
      datasets: [{
        data: momMonths.map(m => m.total),
        backgroundColor: momMonths.map((_, i) => i === 5 ? '#1a73e8' : 'rgba(26,115,232,0.35)'),
        borderRadius: 6,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 11 }, callback: yTick } },
      },
    },
  });

  // Navigation
  viewContainer.querySelector('#analysis-prev').addEventListener('click', async () => {
    const prevStart = addDays(cycle.start, -1);
    state.analysisViewingCycle = await getCycleForDate(prevStart);
    await renderAnalysis();
  });
  viewContainer.querySelector('#analysis-next')?.addEventListener('click', async () => {
    const nextStart = addDays(cycle.end, 1);
    state.analysisViewingCycle = await getCycleForDate(nextStart);
    await renderAnalysis();
  });

  // Category compare toggle
  viewContainer.querySelector('#compare-last').addEventListener('click', () => {
    state.analysisCatCompare = 'lastMonth'; renderAnalysis();
  });
  viewContainer.querySelector('#compare-avg').addEventListener('click', () => {
    state.analysisCatCompare = 'avg12'; renderAnalysis();
  });
}

function makeDistCard(d, catMap) {
  const cat = catMap[d.categoryId];
  const progress = Math.min(100, Math.max(0, diffDays(d.startDate, today()) / Math.max(1, diffDays(d.startDate, d.endDate)) * 100));
  return `
    <div class="dist-card" data-dist-id="${d.id}">
      <div class="dist-card-header"><span class="dist-card-name">${d.description}</span><span class="dist-card-amount">${fmt(Math.abs(d.totalAmount))}</span></div>
      <div class="dist-card-meta">${cat?.icon ?? ''} ${cat?.name ?? ''} &bull; ${fmtDate(d.startDate)} - ${fmtDate(d.endDate)}</div>
      ${!d.isFinished ? `<div class="dist-progress-wrap"><div class="dist-progress-fill" style="width:${progress}%"></div></div>` : ''}
    </div>
  `;
}

async function renderDistributions() {
  const allDists = await db.distributions.toArray();
  const dists = allDists.filter(d => !d.isIncome);
  const todayStr = today();
  const active = dists.filter(d => d.endDate >= todayStr).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const finished = dists.filter(d => d.endDate < todayStr).sort((a, b) => b.endDate.localeCompare(a.endDate));
  const cats = await db.categories.toArray();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

  viewContainer.innerHTML = `
    <div class="distributions-screen">
      <div class="screen-header">
        <button class="icon-btn" onclick="window.app.navigate('settings')"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
        <span class="screen-title">Big Expenses</span>
        <button class="icon-btn" id="dist-add-btn"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
      </div>
      ${active.length > 0 ? `<div style="padding:12px 12px 4px;font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Active</div>${active.map(d => makeDistCard(d, catMap)).join('')}` : ''}
      ${finished.length > 0 ? `<div style="padding:12px 12px 4px;font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Completed</div>${finished.map(d => makeDistCard(d, catMap)).join('')}` : ''}
      ${dists.length === 0 ? `<div class="empty-state"><div class="empty-icon">📅</div><div class="empty-title">No big expenses</div><div class="empty-text">Spread large costs across a date range so they don't distort your daily balance.</div><button class="btn btn-primary" id="dist-empty-add">Add big expense</button></div>` : ''}
    </div>
  `;

  const distScreen = viewContainer.firstElementChild;
  distScreen.querySelector('#dist-add-btn')?.addEventListener('click', () => openDistEditor(null, false));
  distScreen.querySelector('#dist-empty-add')?.addEventListener('click', () => openDistEditor(null, false));
  delegate(distScreen, 'click', '.dist-card', (e, el) => openDistEditor(Number(el.dataset.distId), false));
}

async function renderExtraIncomes() {
  const allDists = await db.distributions.toArray();
  const dists = allDists.filter(d => d.isIncome);
  const todayStr = today();
  const active = dists.filter(d => d.endDate >= todayStr).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const finished = dists.filter(d => d.endDate < todayStr).sort((a, b) => b.endDate.localeCompare(a.endDate));
  const cats = await db.categories.toArray();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

  viewContainer.innerHTML = `
    <div class="distributions-screen">
      <div class="screen-header">
        <button class="icon-btn" onclick="window.app.navigate('settings')"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
        <span class="screen-title">Extra Incomes</span>
        <button class="icon-btn" id="extra-add-btn"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
      </div>
      ${active.length > 0 ? `<div style="padding:12px 12px 4px;font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Active</div>${active.map(d => makeDistCard(d, catMap)).join('')}` : ''}
      ${finished.length > 0 ? `<div style="padding:12px 12px 4px;font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;letter-spacing:.5px">Completed</div>${finished.map(d => makeDistCard(d, catMap)).join('')}` : ''}
      ${dists.length === 0 ? `<div class="empty-state"><div class="empty-icon">💰</div><div class="empty-title">No extra incomes</div><div class="empty-text">Record lump-sum income spread across a date range, like a bonus or freelance payment.</div><button class="btn btn-primary" id="extra-empty-add">Add extra income</button></div>` : ''}
    </div>
  `;

  const extraScreen = viewContainer.firstElementChild;
  extraScreen.querySelector('#extra-add-btn')?.addEventListener('click', () => openDistEditor(null, true));
  extraScreen.querySelector('#extra-empty-add')?.addEventListener('click', () => openDistEditor(null, true));
  delegate(extraScreen, 'click', '.dist-card', (e, el) => openDistEditor(Number(el.dataset.distId), true));
}

async function openDistEditor(id, isIncomeType = false) {
  const dist = id ? await db.distributions.get(id) : null;
  const isIncomeDist = dist ? !!dist.isIncome : isIncomeType;
  const allCats = await db.categories.toArray();
  const cats = allCats.filter(c => !c.isArchived && (!!c.isIncome === isIncomeDist)).sort((a, b) => a.sortOrder - b.sortOrder);
  const title = isIncomeDist ? (dist ? 'Edit Extra Income' : 'Add Extra Income') : (dist ? 'Edit Big Expense' : 'Add Big Expense');
  const goBack = () => isIncomeDist ? renderExtraIncomes() : renderDistributions();

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header"><span class="sheet-title">${title}</span><button class="sheet-close" id="dist-close">✕</button></div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group"><label class="form-label">Description</label><input class="form-input" id="dist-desc" type="text" value="${dist?.description ?? ''}" placeholder="${isIncomeDist ? 'e.g. Bonus payment' : 'e.g. Holiday flights'}"></div>
        <div class="form-group"><label class="form-label">Total amount (£)</label><input class="form-input" id="dist-amount" type="number" step="0.01" min="0" value="${dist ? Math.abs(dist.totalAmount) : ''}"></div>
        <div class="form-group"><label class="form-label">Category</label><select class="form-select" id="dist-cat">${cats.map(c => `<option value="${c.id}" ${dist?.categoryId === c.id ? 'selected' : ''}>${c.icon} ${c.name}</option>`).join('')}</select></div>
        <div class="form-group"><label class="form-label">Spread from</label><input class="form-input" id="dist-start" type="date" value="${dist?.startDate ?? today()}"></div>
        <div class="form-group"><label class="form-label">Spread to</label><input class="form-input" id="dist-end" type="date" value="${dist?.endDate ?? today()}"></div>
        <div style="display:flex;gap:8px;padding-bottom:20px;margin-top:8px">
          ${dist ? `<button class="btn btn-danger" id="dist-del">Delete</button>` : ''}
          <button class="btn btn-primary" id="dist-save" style="flex:1">${dist ? 'Update' : 'Save'}</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#dist-close').onclick = () => overlay.remove();
  if (dist) {
    overlay.querySelector('#dist-del').onclick = async () => {
      if (!confirm('Delete this and all its daily entries?')) return;
      const childIds = await db.transactions.where('distributionId').equals(id).primaryKeys();
      await db.transactions.where('distributionId').equals(id).delete();
      await db.distributions.delete(id);
      await Promise.all(childIds.map(cid => queueDelete('transactions', cid)));
      await queueDelete('distributions', id);
      overlay.remove(); goBack(); showToast('Deleted');
    };
  }
  overlay.querySelector('#dist-save').onclick = async () => {
    const description = overlay.querySelector('#dist-desc').value.trim();
    const totalAmount = parseFloat(overlay.querySelector('#dist-amount').value);
    const categoryId = Number(overlay.querySelector('#dist-cat').value);
    const startDate = overlay.querySelector('#dist-start').value;
    const endDate = overlay.querySelector('#dist-end').value;
    if (!description || isNaN(totalAmount) || !startDate || !endDate) { showToast('Fill in all fields'); return; }
    if (endDate < startDate) { showToast('End date must be after start date'); return; }
    if (id) {
      const oldChildIds = await db.transactions.where('distributionId').equals(id).primaryKeys();
      await db.transactions.where('distributionId').equals(id).delete();
      await Promise.all(oldChildIds.map(cid => queueDelete('transactions', cid)));
    }
    const distData = { description, totalAmount, categoryId, startDate, endDate, isIncome: isIncomeDist, isFinished: endDate < today() };
    let distId;
    if (id) { await db.distributions.update(id, distData); distId = id; }
    else { distId = await db.distributions.add(distData); }
    await queueWrite('distributions', distId);
    const children = generateDistributionChildren({ ...distData, id: distId });
    await db.transactions.bulkAdd(children);
    const newChildren = await db.transactions.where('distributionId').equals(distId).toArray();
    await Promise.all(newChildren.map(c => queueWrite('transactions', c.id)));
    overlay.remove(); goBack(); showToast(id ? 'Updated' : `Created ${children.length} daily entries`);
  };
}

async function renderAccounts() {
  const accounts = await db.accounts.where('isActive').equals(1).sortBy('sortOrder');
  const snapshots = await db.accountSnapshots.toArray();
  const latestByAccount = {};
  for (const s of snapshots) {
    if (!latestByAccount[s.accountId] || s.date > latestByAccount[s.accountId].date) latestByAccount[s.accountId] = s;
  }
  let totalAssets = 0, totalLiabilities = 0;
  for (const acc of accounts) {
    const snap = latestByAccount[acc.id];
    if (!snap) continue;
    if (acc.isAsset) totalAssets += snap.balance; else totalLiabilities += Math.abs(snap.balance);
  }
  const netWealth = totalAssets - totalLiabilities;
  const accountIcon = type => ({ bank: '🏦', credit: '💳', savings: '🏙️', investment: '📈', loan: '📋', pension: '👴', property: '🏠', mortgage: '🏠', holding: '🤝' }[type] ?? '💰');

  viewContainer.innerHTML = `
    <div class="accounts-screen">
      <div class="net-wealth-hero">
        <div class="net-wealth-label">Net wealth</div>
        <div class="net-wealth-amount">${fmt(netWealth)}</div>
        <div class="net-wealth-change">Assets ${fmt(totalAssets)} - Liabilities ${fmt(totalLiabilities)}</div>
      </div>
      <div class="accounts-list" style="padding-bottom:80px">
        <div style="display:flex;justify-content:flex-end;margin-bottom:8px">
          <button class="btn btn-primary" id="snap-add-btn" style="font-size:13px;padding:8px 16px">Record snapshot</button>
        </div>
        ${accounts.map(acc => {
          const snap = latestByAccount[acc.id];
          const bal = snap?.balance ?? null;
          return `
            <div class="account-card" data-acc-id="${acc.id}">
              <div class="account-icon" style="background:${acc.isAsset ? '#e8f5e9' : '#ffebee'}">${accountIcon(acc.type)}</div>
              <div class="account-info"><div class="account-name">${acc.name}</div><div class="account-type">${snap ? fmtDate(snap.date) : 'No data'}</div></div>
              <div class="account-balance ${bal != null && bal < 0 ? 'negative' : ''}">${bal != null ? fmt(bal) : '-'}</div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;
  viewContainer.querySelector('#snap-add-btn').onclick = () => openSnapshotEntry(accounts, latestByAccount);
}

async function openSnapshotEntry(accounts, latest) {
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header"><span class="sheet-title">Record Balances</span><button class="sheet-close" id="snap-close">✕</button></div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group"><label class="form-label">Date</label><input class="form-input" id="snap-date" type="date" value="${today()}"></div>
        ${accounts.map(acc => {
          const prev = latest[acc.id]?.balance;
          return `<div class="form-group"><label class="form-label">${acc.name}${prev != null ? ` (was ${fmt(prev)})` : ''}</label><input class="form-input snap-val" type="number" step="0.01" data-acc-id="${acc.id}" value="${prev ?? ''}" placeholder="0.00"></div>`;
        }).join('')}
        <button class="btn btn-primary btn-full" id="snap-save" style="margin-bottom:20px">Save snapshot</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#snap-close').onclick = () => overlay.remove();
  overlay.querySelector('#snap-save').onclick = async () => {
    const date = overlay.querySelector('#snap-date').value;
    const entries = [];
    overlay.querySelectorAll('.snap-val').forEach(input => {
      const val = input.value.trim();
      if (val !== '') entries.push({ accountId: Number(input.dataset.accId), date, balance: parseFloat(val), note: '' });
    });
    if (!entries.length) { showToast('Enter at least one balance'); return; }
    await db.accountSnapshots.bulkAdd(entries);
    const saved = await db.accountSnapshots.where('date').equals(date).toArray();
    await Promise.all(saved.slice(-entries.length).map(s => queueWrite('accountSnapshots', s.id)));
    overlay.remove(); renderAccounts(); showToast(`Saved ${entries.length} balances`);
  };
}

async function openSavingsSheet() {
  const targets = (await db.savingsTargets.toArray()).sort((a, b) => b.startDate.localeCompare(a.startDate));
  const cycle = await getCurrentCycle();
  const { monthlyIncome, monthlyExpenses } = await calcDailyAllowance(cycle.start, cycle.end);
  const takeHome = monthlyIncome - monthlyExpenses;

  function renderTargetList() {
    const listEl = overlay.querySelector('#sav-list');
    listEl.innerHTML = targets.length === 0
      ? `<div style="padding:16px;text-align:center;color:var(--text-2);font-size:14px">No savings targets yet</div>`
      : targets.map((t, i) => {
          const endLabel = (!t.endDate || t.endDate === '4001-01-01') ? 'open-ended' : fmtDate(t.endDate);
          return `<div class="settings-row" data-sav-idx="${i}" style="cursor:pointer">
            <div style="flex:1">
              <div style="font-size:15px;font-weight:500">${fmt(t.amount ?? 0)}/month</div>
              <div style="font-size:12px;color:var(--text-2)">${fmtDate(t.startDate)} – ${endLabel}</div>
            </div>
            <span class="settings-row-chevron">›</span>
          </div>`;
        }).join('');
  }

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" style="max-height:80vh">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Savings Targets</span>
        <button class="sheet-close" id="sav-close">✕</button>
      </div>
      <div style="padding:0 12px 8px">
        <button class="btn btn-primary btn-full" id="sav-add-btn">+ Add target</button>
      </div>
      <div id="sav-list" style="overflow-y:auto"></div>
    </div>
  `;
  document.body.appendChild(overlay);
  renderTargetList();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#sav-close').onclick = () => overlay.remove();

  const openEditor = (target) => {
    const isNew = !target;
    let editorPence = Math.round((target?.amount ?? 0) * 100);

    const eOverlay = document.createElement('div');
    eOverlay.className = 'sheet-overlay';
    eOverlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title">${isNew ? 'Add' : 'Edit'} Savings Target</span>
          <button class="sheet-close" id="sav-e-close">✕</button>
        </div>
        <div class="sheet-body" style="padding:16px">
          <div class="form-group">
            <label class="form-label">Amount (£/month)</label>
            <div class="form-input" id="sav-e-amount-display" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;font-size:17px;font-weight:600;color:var(--text)">
              <span id="sav-e-amount-val">${editorPence > 0 ? fmt(editorPence / 100) : '£0.00'}</span>
              <span style="color:var(--text-2);font-size:18px">›</span>
            </div>
          </div>
          <div class="form-group"><label class="form-label">Start date</label>
            <input class="form-input" id="sav-e-start" type="date" value="${target?.startDate ?? today()}"></div>
          <div class="form-group"><label class="form-label">End date (leave blank = open-ended)</label>
            <input class="form-input" id="sav-e-end" type="date" value="${(target?.endDate && target.endDate !== '4001-01-01') ? target.endDate : ''}"></div>
          <div style="background:var(--bg);border-radius:var(--radius-sm);padding:12px;font-size:13px;line-height:2;color:var(--text-2)" id="sav-e-stats">
          </div>
          <div style="display:flex;gap:8px;margin-top:16px;padding-bottom:20px">
            ${!isNew ? `<button class="btn btn-danger" id="sav-e-del">Delete</button>` : ''}
            <button class="btn btn-primary" id="sav-e-save" style="flex:1">${isNew ? 'Add' : 'Update'}</button>
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(eOverlay);

    function updateStats() {
      const amount = editorPence / 100;
      const pctIncome = monthlyIncome > 0 ? (amount / monthlyIncome * 100).toFixed(1) : '—';
      const pctTakeHome = takeHome > 0 ? (amount / takeHome * 100).toFixed(1) : '—';
      eOverlay.querySelector('#sav-e-stats').innerHTML = `
        <div style="display:flex;justify-content:space-between"><span>Monthly income</span><span>${fmt(monthlyIncome)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>Monthly expenses</span><span>${fmt(monthlyExpenses)}</span></div>
        <div style="display:flex;justify-content:space-between"><span>Take-home</span><span>${fmt(takeHome)}</span></div>
        <div style="display:flex;justify-content:space-between;border-top:1px solid var(--border);margin-top:4px;padding-top:4px"><span>% of income</span><span>${pctIncome}%</span></div>
        <div style="display:flex;justify-content:space-between"><span>% of take-home</span><span>${pctTakeHome}%</span></div>
      `;
    }
    updateStats();

    eOverlay.onclick = e => { if (e.target === eOverlay) eOverlay.remove(); };
    eOverlay.querySelector('#sav-e-close').onclick = () => eOverlay.remove();

    eOverlay.querySelector('#sav-e-amount-display').onclick = () => {
      const nOverlay = document.createElement('div');
      nOverlay.className = 'sheet-overlay';
      let npPence = editorPence;
      nOverlay.innerHTML = `
        <div class="sheet">
          <div class="sheet-handle"></div>
          <div class="sheet-header">
            <span class="sheet-title">Monthly savings amount</span>
            <button class="sheet-close" id="sav-np-close">✕</button>
          </div>
          <div class="sheet-body">
            <div class="entry-amount-display ${npPence === 0 ? 'placeholder' : ''}" id="sav-np-display">
              ${npPence > 0 ? fmt(npPence / 100) : '£0.00'}
            </div>
          </div>
          <div class="numpad">
            ${['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(k => `
              <button class="numpad-key ${k === '⌫' ? 'delete' : ''}" data-key="${k}">${k}</button>
            `).join('')}
          </div>
          <div style="padding:12px 16px 24px">
            <button class="btn btn-primary btn-full" id="sav-np-ok">Done</button>
          </div>
        </div>
      `;
      document.body.appendChild(nOverlay);
      nOverlay.onclick = e => { if (e.target === nOverlay) nOverlay.remove(); };
      nOverlay.querySelector('#sav-np-close').onclick = () => nOverlay.remove();

      function refreshDisplay() {
        const el = nOverlay.querySelector('#sav-np-display');
        el.textContent = npPence > 0 ? fmt(npPence / 100) : '£0.00';
        el.className = 'entry-amount-display' + (npPence === 0 ? ' placeholder' : '');
      }

      delegate(nOverlay, 'click', '.numpad-key', (e, el) => {
        const key = el.dataset.key;
        if (key === '⌫') {
          npPence = Math.floor(npPence / 10);
        } else if (key !== '.') {
          const next = npPence * 10 + parseInt(key);
          if (next <= 9999999) npPence = next;
        }
        el.classList.add('pressed');
        setTimeout(() => el.classList.remove('pressed'), 120);
        refreshDisplay();
      });

      nOverlay.querySelector('#sav-np-ok').onclick = () => {
        editorPence = npPence;
        eOverlay.querySelector('#sav-e-amount-val').textContent = editorPence > 0 ? fmt(editorPence / 100) : '£0.00';
        updateStats();
        nOverlay.remove();
      };
    };

    if (!isNew) {
      eOverlay.querySelector('#sav-e-del').onclick = async () => {
        if (!confirm('Delete this savings target?')) return;
        await db.savingsTargets.delete(target.id);
        try { await queueDelete('savingsTargets', target.id); } catch {}
        targets.splice(targets.indexOf(target), 1);
        eOverlay.remove(); renderTargetList();
      };
    }
    eOverlay.querySelector('#sav-e-save').onclick = async () => {
      const amount = editorPence / 100;
      const startDate = eOverlay.querySelector('#sav-e-start').value;
      const endRaw = eOverlay.querySelector('#sav-e-end').value;
      const endDate = endRaw || '4001-01-01';
      if (amount < 0) { showToast('Enter a valid amount'); return; }
      if (!startDate) { showToast('Enter a start date'); return; }
      if (isNew) {
        const id = await db.savingsTargets.add({ amount, startDate, endDate, createdAt: new Date().toISOString() });
        try { await queueWrite('savingsTargets', id); } catch {}
        targets.unshift(await db.savingsTargets.get(id));
      } else {
        await db.savingsTargets.update(target.id, { amount, startDate, endDate });
        try { await queueWrite('savingsTargets', target.id); } catch {}
        Object.assign(target, { amount, startDate, endDate });
        targets.sort((a, b) => b.startDate.localeCompare(a.startDate));
      }
      eOverlay.remove(); renderTargetList();
      showToast(isNew ? 'Savings target added' : 'Savings target updated');
    };
  };

  overlay.querySelector('#sav-add-btn').onclick = () => openEditor(null);
  delegate(overlay, 'click', '[data-sav-idx]', (e, el) => openEditor(targets[Number(el.dataset.savIdx)]));
}

// ── Net Wealth ────────────────────────────────────────────────────────────────

function wealthGroupForAccount(acc) {
  return ['bank', 'credit', 'savings', 'holding'].includes(acc.type) ? 'cash' : 'other';
}

function nearestEvenMonthFirst() {
  const now = new Date();
  let m = now.getMonth() + 1;
  let y = now.getFullYear();
  if (m % 2 !== 0) { m--; if (m === 0) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

function openAmountPad(title, initialValue, onConfirm, opts = {}) {
  const { prefix = '£', suffix = '', noNegative = false, decimals = 2 } = opts;
  let pence = Math.round(Math.abs(initialValue) * Math.pow(10, decimals));
  let negative = !noNegative && initialValue < 0;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  const render = () => {
    const num = pence / Math.pow(10, decimals);
    const formatted = decimals > 0
      ? num.toLocaleString('en-GB', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
      : String(Math.round(num));
    const displayVal = (negative ? '-' : '') + prefix + formatted + suffix;
    overlay.querySelector('#ap-display').textContent = displayVal;
    overlay.querySelector('#ap-display').style.color = negative ? 'var(--coral)' : 'var(--text)';
  };
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header"><span class="sheet-title">${title}</span><button class="sheet-close" id="ap-close">✕</button></div>
      <div class="sheet-body">
        <div class="entry-amount-display" id="ap-display" style="font-size:32px;padding:12px 20px">${prefix}0${suffix}</div>
        ${noNegative ? '' : `<div style="padding:0 16px 6px">
          <button id="ap-neg-toggle" style="font-size:12px;padding:4px 12px;border-radius:20px;border:1.5px solid var(--border);background:transparent;color:var(--text-2);cursor:pointer">+/− toggle</button>
        </div>`}
        <div class="numpad">
          ${['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(k => `<button class="numpad-key ${k==='⌫'?'delete':''}" data-key="${k}">${k}</button>`).join('')}
        </div>
        <div style="padding:8px 16px 20px"><button class="btn btn-primary btn-full" id="ap-confirm">✓ Confirm</button></div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  render();
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#ap-close').onclick = () => overlay.remove();
  overlay.querySelector('#ap-neg-toggle')?.addEventListener('click', () => { negative = !negative; render(); });
  overlay.querySelectorAll('.numpad-key').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.key;
      if (k === '⌫') { pence = Math.floor(pence / 10); }
      else if (k !== '.') { pence = pence * 10 + Number(k); }
      const maxPence = 99999999 * Math.pow(10, decimals - 2);
      if (pence > maxPence) pence = maxPence;
      render();
    });
  });
  overlay.querySelector('#ap-confirm').onclick = () => {
    overlay.remove();
    const scale = Math.pow(10, decimals);
    onConfirm(negative ? -(pence / scale) : pence / scale);
  };
}

async function renderNetWealth() {
  const [accounts, allSnapshots, inflationRate, inflationOverridesRaw] = await Promise.all([
    db.accounts.orderBy('sortOrder').toArray(),
    db.accountSnapshots.toArray(),
    getSetting('inflationRate'),
    getSetting('inflationOverrides'),
  ]);

  const activeAccounts = accounts.filter(a => a.isActive !== false && a.type !== 'holding_archived');
  const allCashAccs = activeAccounts.filter(a => wealthGroupForAccount(a) === 'cash');
  const allOtherAccs = activeAccounts.filter(a => wealthGroupForAccount(a) === 'other');

  // Group snapshots by date
  const snapshotMap = {}; // { date: { accountId: balance } }
  for (const s of allSnapshots) {
    if (!snapshotMap[s.date]) snapshotMap[s.date] = {};
    snapshotMap[s.date][s.accountId] = s.balance ?? 0;
  }
  const dates = Object.keys(snapshotMap).sort().reverse(); // newest first

  // Only show accounts that have at least one snapshot value
  const cashAccs = allCashAccs.filter(a => dates.some(d => snapshotMap[d]?.[a.id] != null));
  const otherAccs = allOtherAccs.filter(a => dates.some(d => snapshotMap[d]?.[a.id] != null));

  const rate = inflationRate ?? 3;
  const inflationOverrides = inflationOverridesRaw ? JSON.parse(inflationOverridesRaw) : {};
  const sortedDatesAsc = [...dates].reverse();
  const firstDate = sortedDatesAsc[0];

  const netByDate = {};
  const cashTotalByDate = {};
  for (const d of dates) {
    const vals = snapshotMap[d];
    netByDate[d] = activeAccounts.reduce((s, a) => s + (vals[a.id] ?? 0), 0);
    cashTotalByDate[d] = allCashAccs.reduce((s, a) => s + (vals[a.id] ?? 0), 0);
  }
  const baseNetWealth = firstDate ? netByDate[firstDate] : 0;

  function inflationValue(dateStr) {
    if (inflationOverrides[dateStr] != null) return inflationOverrides[dateStr];
    if (!firstDate) return 0;
    const years = diffDays(firstDate, dateStr) / 365;
    return baseNetWealth * Math.pow(1 + rate / 100, years);
  }

  const lastOctDate = sortedDatesAsc.filter(d => d.slice(5, 7) === '10').pop();
  const lastOctNet = lastOctDate ? netByDate[lastOctDate] : null;

  // Full amounts (not compact)
  const fmt2 = v => {
    const abs = Math.abs(v);
    const str = abs.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return `${v < 0 ? '-' : ''}£${str}`;
  };

  function cellVal(accId, date) {
    const v = snapshotMap[date]?.[accId];
    return v != null ? fmt2(v) : '—';
  }

  // Table styles
  const colStyle = 'min-width:96px;text-align:right;padding:5px 6px;font-size:12px;white-space:nowrap;';
  const headerColStyle = colStyle + 'font-weight:600;color:var(--text-2);font-size:11px;';
  const labelStyle = 'position:sticky;left:0;background:var(--card);z-index:2;min-width:110px;max-width:110px;padding:5px 8px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  const groupHeaderStyle = 'position:sticky;left:0;background:var(--bg);z-index:2;min-width:110px;padding:5px 8px 2px;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-2);padding-top:10px;white-space:nowrap;';
  const totalStyle = labelStyle + 'font-weight:700;border-top:1.5px solid var(--border);';
  const totalCellStyle = colStyle + 'font-weight:700;border-top:1.5px solid var(--border);';
  const wealthStyle = labelStyle + 'font-weight:800;font-size:13px;';
  const wealthCellStyle = colStyle + 'font-weight:800;font-size:13px;';

  function accRows(accs) {
    return accs.map(a => `
      <tr>
        <td style="${labelStyle}">${a.name}</td>
        ${dates.map(d => `<td style="${colStyle}">${cellVal(a.id, d)}</td>`).join('')}
      </tr>
    `).join('');
  }

  function groupTotal(accs, date) {
    return accs.reduce((s, a) => s + (snapshotMap[date]?.[a.id] ?? 0), 0);
  }

  const tableHTML = dates.length === 0 ? '' : `
    <div style="overflow-x:auto">
      <table style="border-collapse:collapse;width:max-content;min-width:100%">
        <thead>
          <tr>
            <th style="${groupHeaderStyle}"></th>
            ${dates.map(d => `<th style="${headerColStyle}">${new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</th>`).join('')}
          </tr>
        </thead>
        <tbody>
          <tr><td style="${groupHeaderStyle}">Cash</td>${dates.map(() => `<td style="background:var(--bg);padding:0;min-width:96px"></td>`).join('')}</tr>
          ${accRows(cashAccs)}
          <tr>
            <td style="${totalStyle}">Cash total</td>
            ${dates.map(d => `<td style="${totalCellStyle}">${fmt2(groupTotal(allCashAccs, d))}</td>`).join('')}
          </tr>
          <tr><td style="${groupHeaderStyle}">Assets &amp; Debts</td>${dates.map(() => `<td style="background:var(--bg);padding:0;min-width:96px"></td>`).join('')}</tr>
          ${accRows(otherAccs)}
          <tr>
            <td style="${totalStyle}">Assets &amp; Debts total</td>
            ${dates.map(d => `<td style="${totalCellStyle}">${fmt2(groupTotal(allOtherAccs, d))}</td>`).join('')}
          </tr>
          <tr>
            <td style="${wealthStyle}">Net Wealth</td>
            ${dates.map(d => `<td style="${wealthCellStyle}">${fmt2(netByDate[d])}</td>`).join('')}
          </tr>
          <tr>
            <td style="${labelStyle}">Change (vs last Oct)</td>
            ${dates.map(d => {
              if (!lastOctNet || d === lastOctDate) return `<td style="${colStyle}">—</td>`;
              const chg = netByDate[d] - lastOctNet;
              return `<td style="${colStyle};color:${chg >= 0 ? '#43a047' : '#e53935'}">${chg >= 0 ? '+' : ''}${fmt2(chg)}</td>`;
            }).join('')}
          </tr>
          <tr>
            <td style="${labelStyle};color:var(--text-2)">Inflation tracker</td>
            ${dates.map(d => `<td style="${colStyle};color:var(--text-2)">${fmt2(inflationValue(d))}</td>`).join('')}
          </tr>
        </tbody>
      </table>
    </div>
  `;

  const chartDates = sortedDatesAsc;
  const chartLabels = chartDates.map(d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
  const chartNetWealth = chartDates.map(d => netByDate[d]);
  const chartCash = chartDates.map(d => cashTotalByDate[d]);
  const chartInflation = chartDates.map(d => inflationValue(d));

  viewContainer.innerHTML = `
    <div class="settings-screen">
      <div class="screen-header">
        <button class="icon-btn" onclick="window.app.navigate('settings')">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="screen-title">Net Wealth</span>
        <button class="icon-btn" id="nw-add-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>

      ${dates.length === 0 ? `
        <div class="empty-state"><div class="empty-icon">📊</div>
          <div class="empty-title">No snapshots yet</div>
          <div class="empty-text">Record your net wealth bi-monthly to track progress over time.</div>
          <button class="btn btn-primary" id="nw-empty-add">Add first snapshot</button>
        </div>
      ` : `
        <div class="analysis-section" style="margin:10px 12px">
          <div class="analysis-section-title">Net Wealth over time</div>
          <div class="chart-wrap" style="height:240px"><canvas id="chart-nw"></canvas></div>
        </div>
        <div class="settings-card" style="margin:10px 12px;border-radius:var(--radius);overflow:hidden">
          ${tableHTML}
        </div>
        <div class="settings-card" style="margin:4px 12px 8px">
          <div class="settings-row" style="cursor:pointer" id="nw-edit-past-btn">
            <span class="settings-row-icon">✏️</span>
            <span class="settings-row-label">Edit a past snapshot</span>
            <span class="settings-row-chevron">›</span>
          </div>
        </div>
      `}

      <div class="settings-section" style="margin-top:12px">
        <div class="settings-section-title">Inflation settings</div>
        <div class="settings-card">
          <div class="settings-row" style="cursor:pointer" id="nw-inflation-rate-row">
            <span class="settings-row-icon">📈</span>
            <span class="settings-row-label">Annual inflation rate</span>
            <span style="margin-left:auto;color:var(--text-2);font-size:14px">${rate}%</span>
            <span class="settings-row-chevron">›</span>
          </div>
          ${firstDate && dates.length > 0 ? `<div class="settings-row" style="cursor:pointer" id="nw-inflation-override-row">
            <span class="settings-row-icon">✏️</span>
            <span class="settings-row-label">Override inflation values</span>
            <span class="settings-row-chevron">›</span>
          </div>` : ''}
        </div>
      </div>

      ${dates.length > 0 ? `
        <div class="settings-section">
          <div class="settings-section-title">Export</div>
          <div class="settings-card">
            <div class="settings-row" style="cursor:pointer" id="nw-csv-btn">
              <span class="settings-row-icon">📥</span>
              <span class="settings-row-label">Download wealth data (CSV)</span>
              <span class="settings-row-chevron">›</span>
            </div>
          </div>
        </div>
      ` : ''}

      <div style="padding-bottom:80px"></div>
    </div>
  `;

  const nwScreen = viewContainer.querySelector('.settings-screen');
  nwScreen.querySelector('#nw-add-btn').addEventListener('click', () => openWealthSnapshotEditor(null));
  const emptyAdd = nwScreen.querySelector('#nw-empty-add');
  if (emptyAdd) emptyAdd.addEventListener('click', () => openWealthSnapshotEditor(null));

  nwScreen.querySelector('#nw-edit-past-btn')?.addEventListener('click', () => openPastSnapshotPicker(dates));

  nwScreen.querySelector('#nw-inflation-rate-row')?.addEventListener('click', () => {
    openAmountPad('Annual inflation rate', rate, val => {
      setSetting('inflationRate', Math.min(50, Math.max(0, val))).then(() => renderNetWealth());
    }, { prefix: '', suffix: '%', noNegative: true, decimals: 1 });
  });

  nwScreen.querySelector('#nw-inflation-override-row')?.addEventListener('click', () => {
    openInflationOverrideEditor(dates, inflationValue, inflationOverrides);
  });

  nwScreen.querySelector('#nw-csv-btn')?.addEventListener('click', () => {
    downloadWealthCSV(activeAccounts, cashAccs, otherAccs, snapshotMap, dates);
  });

  if (dates.length > 1) {
    const allVals = [...chartNetWealth, ...chartCash, ...chartInflation].filter(v => v != null);
    const maxVal = Math.max(...allVals);
    const minVal = Math.min(0, ...allVals);

    // Pick a nice step size so we get 4-7 evenly spaced ticks
    const range = maxVal - minVal;
    const niceSteps = [500, 1000, 2000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
    const stepSize = niceSteps.find(s => range / s <= 7) ?? 500000;
    const yMin = Math.floor(minVal / stepSize) * stepSize;
    const yMax = Math.ceil(maxVal / stepSize) * stepSize;
    const yTick = v => Math.abs(v) >= 1000 ? `£${(v/1000).toFixed(0)}k` : `£${v.toFixed(0)}`;

    new Chart(viewContainer.querySelector('#chart-nw').getContext('2d'), {
      type: 'line',
      data: {
        labels: chartLabels,
        datasets: [
          { label: 'Net Wealth', data: chartNetWealth, borderColor: '#1a73e8', backgroundColor: 'rgba(26,115,232,0.08)', borderWidth: 2.5, fill: true, tension: 0.3, pointRadius: 3 },
          { label: 'Cash', data: chartCash, borderColor: '#43a047', backgroundColor: 'transparent', borderWidth: 1.8, fill: false, tension: 0.3, pointRadius: 2 },
          { label: 'Inflation', data: chartInflation, borderColor: '#e53935', borderDash: [5, 4], borderWidth: 1.5, fill: false, tension: 0.3, pointRadius: 0 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: true, position: 'top', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } } },
        scales: {
          x: { grid: { display: false }, ticks: { maxRotation: 90, minRotation: 90, font: { size: 10 } } },
          y: { min: yMin, max: yMax, grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { stepSize, font: { size: 11 }, callback: yTick } },
        },
      },
    });
  }
}

function downloadWealthCSV(activeAccounts, cashAccs, otherAccs, snapshotMap, dates) {
  const sortedDates = [...dates].reverse(); // oldest first for CSV
  const header = ['Account', 'Group', ...sortedDates.map(d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }))];
  const rows = [header];
  for (const a of [...cashAccs, ...otherAccs]) {
    const group = cashAccs.includes(a) ? 'Cash' : 'Assets & Debts';
    rows.push([a.name, group, ...sortedDates.map(d => (snapshotMap[d]?.[a.id] ?? '').toString())]);
  }
  // Totals rows
  rows.push(['Cash Total', '', ...sortedDates.map(d => cashAccs.reduce((s, a) => s + (snapshotMap[d]?.[a.id] ?? 0), 0).toFixed(2))]);
  rows.push(['Assets & Debts Total', '', ...sortedDates.map(d => otherAccs.reduce((s, a) => s + (snapshotMap[d]?.[a.id] ?? 0), 0).toFixed(2))]);
  rows.push(['Net Wealth', '', ...sortedDates.map(d => activeAccounts.reduce((s, a) => s + (snapshotMap[d]?.[a.id] ?? 0), 0).toFixed(2))]);

  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `net-wealth-${today()}.csv`; a.click();
  URL.revokeObjectURL(url);
  showToast('CSV downloaded');
}

async function openWealthSnapshotEditor(existingDate) {
  let accounts = await db.accounts.orderBy('sortOrder').toArray();

  let snapshotDate = existingDate;
  if (!existingDate) {
    const existingSnaps = await db.accountSnapshots.toArray();
    const existingDates = [...new Set(existingSnaps.map(s => s.date))].sort();
    const lastDate = existingDates[existingDates.length - 1];
    if (lastDate) {
      let y = Number(lastDate.slice(0, 4));
      let m = Number(lastDate.slice(5, 7)) + 2;
      if (m > 12) { m -= 12; y++; }
      snapshotDate = `${y}-${String(m).padStart(2, '0')}-01`;
    } else {
      snapshotDate = nearestEvenMonthFirst();
    }
  }
  let currentDate = snapshotDate;
  const existingVals = {};
  if (existingDate) {
    const rows = await db.accountSnapshots.filter(s => s.date === existingDate).toArray();
    rows.forEach(r => { existingVals[r.accountId] = r.balance ?? 0; });
  }

  // Track in-memory account edits (name changes, deletions, additions)
  // We clone the accounts so edits don't touch DB until save
  let editedAccounts = accounts.filter(a => a.isActive !== false).map(a => ({ ...a }));
  const amountsByAccId = {};
  for (const a of editedAccounts) amountsByAccId[a.id] = existingVals[a.id] ?? null;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  let nextTempId = -1; // negative IDs for new accounts not yet in DB

  function buildContent() {
    // Preserve whatever date the user has set before re-rendering
    const existingDateInput = overlay.querySelector('#nw-e-date');
    if (existingDateInput && existingDateInput.value) currentDate = existingDateInput.value;

    const cashAccs = editedAccounts.filter(a => wealthGroupForAccount(a) === 'cash');
    const otherAccs = editedAccounts.filter(a => wealthGroupForAccount(a) === 'other');

    function accRow(a) {
      const val = amountsByAccId[a.id];
      const isDebt = !a.isAsset;
      const displayVal = val != null ? fmt(Math.abs(val)) + (val < 0 ? ' (neg)' : '') : '—';
      return `<div class="settings-row nw-acc-row" data-acc-id="${a.id}" style="gap:8px;align-items:center;cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px">${a.name}${isDebt ? ' <span style="font-size:11px;color:var(--text-2)">(debt)</span>' : ''}</div>
        </div>
        <div class="nw-amount-tap" style="font-size:15px;font-weight:600;color:${val != null && val < 0 ? 'var(--coral)' : 'var(--text)'};min-width:100px;text-align:right">${val != null ? (val < 0 ? '-' : '') + fmt(Math.abs(val)) : '—'}</div>
        <button class="nw-edit-acc-btn" data-acc-id="${a.id}" style="padding:4px 6px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--text-2);font-size:11px;flex-shrink:0">✏️</button>
      </div>`;
    }

    function groupSection(accs, groupLabel, groupKey) {
      return `
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-2);padding:12px 0 4px">${groupLabel}</div>
        <div class="settings-card" style="margin-bottom:8px">
          ${accs.map(accRow).join('')}
        </div>
        <button class="nw-add-acc-btn" data-group="${groupKey}" style="display:flex;align-items:center;gap:6px;background:transparent;border:1.5px dashed var(--border);border-radius:var(--radius-sm);padding:8px 12px;width:100%;cursor:pointer;color:var(--text-2);font-size:13px;margin-bottom:16px">
          <span>+</span> Add row to ${groupLabel}
        </button>
      `;
    }

    overlay.innerHTML = `
      <div class="sheet" style="max-height:92vh">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title">${existingDate ? 'Edit' : 'New'} Snapshot</span>
          <button class="sheet-close" id="nw-e-close">✕</button>
        </div>
        <div class="sheet-body" style="padding:16px;overflow-y:auto;max-height:calc(92vh - 60px)">
          <div class="form-group">
            <label class="form-label">Snapshot date</label>
            <input class="form-input" id="nw-e-date" type="date" value="${currentDate}">
          </div>
          ${groupSection(cashAccs, 'Cash accounts', 'cash')}
          ${groupSection(otherAccs, 'Assets & Debts', 'other')}
          <div style="font-size:12px;color:var(--text-2);margin-bottom:12px">Enter debts as negative values (tap the amount, then toggle +/−).</div>
          <div style="display:flex;gap:8px;padding-bottom:24px">
            ${existingDate ? `<button class="btn btn-danger" id="nw-e-del">Delete</button>` : ''}
            <button class="btn btn-primary" id="nw-e-save" style="flex:1">Save Snapshot</button>
          </div>
        </div>
      </div>
    `;

    overlay.querySelector('#nw-e-close').onclick = () => overlay.remove();

    // Amount tap → open numpad
    overlay.querySelectorAll('.nw-acc-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.nw-edit-acc-btn')) return;
        const accId = Number(row.dataset.accId);
        const curVal = amountsByAccId[accId] ?? 0;
        const acc = editedAccounts.find(a => a.id === accId);
        openAmountPad(acc?.name ?? 'Amount', curVal, val => {
          amountsByAccId[accId] = val;
          buildContent();
        });
      });
    });

    // Edit account name/delete
    overlay.querySelectorAll('.nw-edit-acc-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const accId = Number(btn.dataset.accId);
        const acc = editedAccounts.find(a => a.id === accId);
        if (!acc) return;
        const newName = prompt('Rename account (or leave blank to delete):', acc.name);
        if (newName === null) return;
        if (newName.trim() === '') {
          editedAccounts = editedAccounts.filter(a => a.id !== accId);
          delete amountsByAccId[accId];
        } else {
          acc.name = newName.trim();
        }
        buildContent();
      });
    });

    // Add account row
    overlay.querySelectorAll('.nw-add-acc-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.group;
        const name = prompt('New account name:');
        if (!name?.trim()) return;
        const isAsset = group === 'cash' ? true : true; // user sets via debt toggle
        const type = group === 'cash' ? 'savings' : 'investment';
        const newAcc = { id: nextTempId--, name: name.trim(), type, isAsset, sortOrder: 999, isActive: true };
        editedAccounts.push(newAcc);
        amountsByAccId[newAcc.id] = 0;
        buildContent();
      });
    });

    if (existingDate) {
      overlay.querySelector('#nw-e-del').onclick = async () => {
        if (!confirm(`Delete snapshot for ${existingDate}?`)) return;
        const toDelete = await db.accountSnapshots.filter(s => s.date === existingDate).toArray();
        await db.accountSnapshots.filter(s => s.date === existingDate).delete();
        toDelete.forEach(r => queueDelete('accountSnapshots', r.id).catch(() => {}));
        overlay.remove();
        renderNetWealth();
        showToast('Snapshot deleted');
      };
    }

    overlay.querySelector('#nw-e-save').onclick = async () => {
      const date = overlay.querySelector('#nw-e-date').value;
      if (!date) { showToast('Enter a date'); return; }

      // Save any new/renamed accounts to DB
      for (const a of editedAccounts) {
        if (a.id < 0) {
          // New account — add to DB and get real ID
          const realId = await db.accounts.add({ name: a.name, type: a.type, isAsset: a.isAsset, sortOrder: a.sortOrder, isActive: true });
          const oldId = a.id;
          a.id = realId;
          amountsByAccId[realId] = amountsByAccId[oldId] ?? 0;
          delete amountsByAccId[oldId];
          queueWrite('accounts', realId).catch(() => {});
        } else {
          // Update name if changed
          const orig = accounts.find(x => x.id === a.id);
          if (orig && orig.name !== a.name) {
            await db.accounts.update(a.id, { name: a.name });
            queueWrite('accounts', a.id).catch(() => {});
          }
        }
      }
      // Mark removed accounts as inactive
      for (const orig of accounts) {
        if (orig.isActive !== false && !editedAccounts.find(a => a.id === orig.id)) {
          await db.accounts.update(orig.id, { isActive: false });
          queueWrite('accounts', orig.id).catch(() => {});
        }
      }

      // Save snapshot records
      await db.accountSnapshots.filter(s => s.date === date).delete();
      const records = editedAccounts
        .filter(a => amountsByAccId[a.id] != null)
        .map(a => ({ accountId: a.id, date, balance: amountsByAccId[a.id] }));
      const ids = await db.accountSnapshots.bulkAdd(records, { allKeys: true });
      ids.forEach(id => queueWrite('accountSnapshots', id).catch(() => {}));
      overlay.remove();
      renderNetWealth();
      showToast('Snapshot saved');
    };
  }

  buildContent();
}

function openPastSnapshotPicker(dates) {
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" style="max-height:80vh">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Edit a past snapshot</span>
        <button class="sheet-close" id="psp-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:8px 0;overflow-y:auto;max-height:calc(80vh - 60px)">
        ${dates.map(d => `<div class="settings-row" style="cursor:pointer;padding:14px 20px" data-pick-date="${d}">
          <span style="font-size:15px">${new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
          <span class="settings-row-chevron">›</span>
        </div>`).join('')}
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#psp-close').onclick = () => overlay.remove();
  overlay.querySelectorAll('[data-pick-date]').forEach(row => {
    row.addEventListener('click', () => {
      overlay.remove();
      openWealthSnapshotEditor(row.dataset.pickDate);
    });
  });
}

function openInflationOverrideEditor(dates, computedInflation, currentOverrides) {
  // dates is newest-first; show newest first
  const overrideValues = { ...currentOverrides };

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" style="max-height:85vh">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Inflation values</span>
        <button class="sheet-close" id="inf-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px;overflow-y:auto;max-height:calc(85vh - 60px)">
        <div style="font-size:13px;color:var(--text-2);margin-bottom:12px;line-height:1.5">Override auto-calculated inflation for specific dates. Tap a value to edit.</div>
        <div id="inf-rows">
          ${dates.map(d => {
            const computed = computedInflation(d);
            const override = overrideValues[d];
            return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px" data-inf-date="${d}">
              <span style="flex:1;font-size:13px">${new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>
              <button class="inf-val-btn" data-date="${d}" style="font-size:14px;font-weight:500;text-align:right;padding:6px 10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:${override != null ? 'var(--text)' : 'var(--text-2)'};cursor:pointer">
                ${override != null ? fmt(override) : fmt(computed)}
              </button>
            </div>`;
          }).join('')}
        </div>
        <button class="btn btn-primary btn-full" id="inf-save" style="margin-top:8px">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#inf-close').onclick = () => overlay.remove();

  function rebuildRows() {
    overlay.querySelector('#inf-rows').innerHTML = dates.map(d => {
      const computed = computedInflation(d);
      const override = overrideValues[d];
      return `<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px" data-inf-date="${d}">
        <span style="flex:1;font-size:13px">${new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</span>
        <button class="inf-val-btn" data-date="${d}" style="font-size:14px;font-weight:500;text-align:right;padding:6px 10px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);color:${override != null ? 'var(--text)' : 'var(--text-2)'};cursor:pointer">
          ${override != null ? fmt(override) : fmt(computed)}
        </button>
      </div>`;
    }).join('');
    attachRowHandlers();
  }

  function attachRowHandlers() {
    overlay.querySelectorAll('.inf-val-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const d = btn.dataset.date;
        const cur = overrideValues[d] ?? computedInflation(d);
        openAmountPad(`Inflation — ${new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`, cur, val => {
          overrideValues[d] = Math.abs(val);
          rebuildRows();
        });
      });
    });
  }
  attachRowHandlers();

  overlay.querySelector('#inf-save').onclick = async () => {
    await setSetting('inflationOverrides', JSON.stringify(overrideValues));
    overlay.remove();
    renderNetWealth();
    showToast('Inflation values saved');
  };
}

// ── Bank of Gilulu ────────────────────────────────────────────────────────────

function bgFmt(v) {
  const abs = Math.abs(v);
  const str = abs.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (v < 0 ? '-' : '') + '£' + str;
}

function bgRunningBalance(txs) {
  let bal = 0;
  return txs.map(t => { bal += t.amount; return { ...t, balance: bal }; });
}

function bgHoldingName(h) {
  return h.name || h.person || h.holder || h.label || h.account || 'Account #' + h.id;
}

async function getGlobalRatePeriods() {
  const raw = await getSetting('bgRatePeriods');
  if (raw) { try { return JSON.parse(raw); } catch {} }
  return [];
}

// Simple interest: amount * rate * days / 365, split across rate periods
function bgInterestOnAmount(amount, txDate, ratePeriods, toDate) {
  if (amount === 0 || ratePeriods.length === 0) return 0;
  const sorted = [...ratePeriods].sort((a, b) => a.fromDate.localeCompare(b.fromDate));
  let interest = 0;
  for (let i = 0; i < sorted.length; i++) {
    const periodStart = sorted[i].fromDate;
    const periodEnd = i + 1 < sorted.length ? sorted[i + 1].fromDate : toDate;
    const start = txDate > periodStart ? txDate : periodStart;
    const end = periodEnd < toDate ? periodEnd : toDate;
    if (start >= end) continue;
    const days = diffDays(start, end);
    interest += amount * sorted[i].rate / 100 * days / 365;
  }
  return interest;
}

// Total with interest: each transaction accrues simple interest from its date to toDate
function bgTotalWithInterest(txs, ratePeriods, toDate) {
  return txs.reduce((sum, t) => {
    return sum + t.amount + bgInterestOnAmount(t.amount, t.date, ratePeriods, toDate);
  }, 0);
}

async function renderBankGilulu(activeHoldingId = null) {
  const holdings = await db.friendHoldings.filter(h => h.isActive !== false).toArray();

  let holding = activeHoldingId
    ? holdings.find(h => h.id === activeHoldingId)
    : holdings[0];

  const ratePeriods = await getGlobalRatePeriods();
  const currentRateEntry = [...ratePeriods].sort((a, b) => b.fromDate.localeCompare(a.fromDate))[0];
  const currentRate = currentRateEntry?.rate ?? null;
  const toDate = today();

  const allTxs = holding
    ? await db.friendTransactions.where('holdingId').equals(holding.id).sortBy('date')
    : [];

  // Total with interest per the spreadsheet formula
  const totalWithInterest = bgTotalWithInterest(allTxs, ratePeriods, toDate);
  const principalTotal = allTxs.reduce((s, t) => s + t.amount, 0);
  const interestEarned = totalWithInterest - principalTotal;

  const feb1 = `${new Date().getFullYear()}-02-01`;

  // Deposited this year: net of deposits/withdrawals since Feb 1
  const depositedThisYear = allTxs
    .filter(t => t.date >= feb1)
    .reduce((s, t) => s + t.amount, 0);

  // This-year interest: accrued from Feb 1 of current year
  const thisYearInterest = allTxs.reduce((sum, t) => {
    const effectiveStart = t.date > feb1 ? t.date : feb1;
    if (effectiveStart >= toDate) return sum;
    return sum + bgInterestOnAmount(t.amount, effectiveStart, ratePeriods, toDate);
  }, 0);

  // Pre-compute running balance (total with interest to today) at each tx, ascending
  const txsWithBalance = allTxs.map((t, i) => {
    const txsUpTo = allTxs.slice(0, i + 1);
    return { ...t, runningBalance: bgTotalWithInterest(txsUpTo, ratePeriods, toDate) };
  });
  const displayTxs = [...txsWithBalance].reverse(); // newest first

  function tabsHTML() {
    return holdings.map(h => `
      <button class="pill-btn${holding && h.id === holding.id ? ' active' : ''}" data-holding-id="${h.id}">${bgHoldingName(h)}</button>
    `).join('') + `<button class="pill-btn" id="bg-add-account">+ Add</button>`;
  }

  function txTableHTML() {
    if (displayTxs.length === 0) return `<div style="text-align:center;padding:24px 0;color:var(--text-2);font-size:14px">No transactions yet</div>`;
    return `
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead>
          <tr style="border-bottom:1.5px solid var(--border)">
            <th style="text-align:left;padding:6px 8px;font-weight:600;color:var(--text-2);font-size:11px">DATE</th>
            <th style="text-align:right;padding:6px 8px;font-weight:600;color:var(--text-2);font-size:11px">AMOUNT</th>
            <th style="text-align:right;padding:6px 8px;font-weight:600;color:var(--text-2);font-size:11px">INTEREST</th>
            <th style="text-align:right;padding:6px 8px;font-weight:600;color:var(--text-2);font-size:11px">BALANCE</th>
          </tr>
        </thead>
        <tbody>
          ${displayTxs.map(t => {
            const interest = bgInterestOnAmount(t.amount, t.date, ratePeriods, toDate);
            const days = diffDays(t.date, toDate);
            return `<tr class="bg-tx-row" data-tx-id="${t.id}" style="border-bottom:1px solid var(--border);cursor:pointer">
              <td style="padding:8px;white-space:nowrap;color:var(--text-2)">${new Date(t.date + 'T12:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' })}<br><span style="font-size:10px">${days}d</span></td>
              <td style="padding:8px;text-align:right;font-weight:600;color:${t.amount >= 0 ? '#43a047' : 'var(--coral)'}">${t.amount >= 0 ? '+' : ''}${bgFmt(t.amount)}</td>
              <td style="padding:8px;text-align:right;color:${interest >= 0 ? '#43a047' : 'var(--coral)'}">${interest >= 0 ? '+' : ''}${bgFmt(interest)}</td>
              <td style="padding:8px;text-align:right;font-weight:700;color:${t.runningBalance >= 0 ? 'var(--text)' : 'var(--coral)'}">${bgFmt(t.runningBalance)}</td>
            </tr>`;
          }).join('')}
          <tr style="border-top:2px solid var(--border);background:var(--bg)">
            <td style="padding:8px;font-weight:700;font-size:12px;color:var(--text-2)">TOTAL</td>
            <td style="padding:8px;text-align:right;font-weight:700">${bgFmt(principalTotal)}</td>
            <td style="padding:8px;text-align:right;font-weight:700;color:${interestEarned >= 0 ? '#43a047' : 'var(--coral)'};">${interestEarned >= 0 ? '+' : ''}${bgFmt(interestEarned)}</td>
            <td style="padding:8px;text-align:right;font-weight:800;font-size:14px">${bgFmt(totalWithInterest)}</td>
          </tr>
        </tbody>
      </table>
    `;
  }

  viewContainer.innerHTML = `
    <div class="settings-screen" id="bg-screen">
      <div class="screen-header">
        <button class="icon-btn" onclick="window.app.navigate('settings')">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="screen-title">Bank of Gilulu</span>
        <button class="icon-btn" id="bg-add-tx-btn" ${!holding ? 'disabled' : ''}>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>

      ${holdings.length === 0 ? `
        <div class="empty-state">
          <div class="empty-icon">🏦</div>
          <div class="empty-title">No accounts yet</div>
          <div class="empty-text">Add accounts for each person whose money you're holding.</div>
          <button class="btn btn-primary" id="bg-first-account">Add first account</button>
        </div>
      ` : `
        <div style="padding:10px 12px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
          ${tabsHTML()}
        </div>

        <!-- Balance card — screenshot-friendly -->
        <div style="margin:12px;padding:20px;background:var(--card);border-radius:var(--radius);box-shadow:0 1px 4px rgba(0,0,0,.08)">
          <div style="font-size:12px;color:var(--text-2);font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px">
            Bank of Gilulu — ${bgHoldingName(holding)}
          </div>
          <div style="font-size:36px;font-weight:800;letter-spacing:-1px;color:${totalWithInterest >= 0 ? 'var(--text)' : 'var(--coral)'}">
            ${bgFmt(totalWithInterest)}
          </div>
          <div style="font-size:12px;color:var(--text-2);margin-top:4px">
            Balance with interest · ${new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}
          </div>
          <div style="display:flex;gap:12px;margin-top:14px">
            <div style="flex:1;background:var(--bg);border-radius:8px;padding:10px 12px">
              <div style="font-size:11px;color:var(--text-2);margin-bottom:2px">${holding?.name === 'Domsey' ? 'Deposited this year' : 'Net deposits'}</div>
              <div style="font-size:14px;font-weight:700">${bgFmt(holding?.name === 'Domsey' ? depositedThisYear : principalTotal)}</div>
            </div>
            <div style="flex:1;background:var(--bg);border-radius:8px;padding:10px 12px">
              <div style="font-size:11px;color:var(--text-2);margin-bottom:2px">This year's interest</div>
              <div style="font-size:14px;font-weight:700;color:#43a047">+${bgFmt(thisYearInterest)}</div>
            </div>
            <div style="flex:1;background:var(--bg);border-radius:8px;padding:10px 12px">
              <div style="font-size:11px;color:var(--text-2);margin-bottom:2px">All time interest</div>
              <div style="font-size:14px;font-weight:700;color:#43a047">${interestEarned >= 0 ? '+' : ''}${bgFmt(interestEarned)}</div>
            </div>
          </div>
          <div style="margin-top:14px">
            <div style="font-size:11px;color:var(--text-2);margin-bottom:6px;font-weight:600;letter-spacing:.3px">RATE: ${currentRate != null ? currentRate + '% p.a.' : 'not set'}</div>
          </div>
        </div>

        <!-- Balance over time chart -->
        ${allTxs.length > 0 ? `
        <div style="margin:0 12px 8px;background:var(--card);border-radius:var(--radius);padding:14px 12px">
          <div style="font-size:12px;font-weight:600;color:var(--text-2);letter-spacing:.4px;margin-bottom:10px">BALANCE OVER TIME</div>
          <div style="position:relative;height:160px"><canvas id="bg-chart"></canvas></div>
        </div>
        ` : ''}

        <!-- Transaction table -->
        <div style="margin:0 12px 8px;background:var(--card);border-radius:var(--radius);overflow:hidden;overflow-x:auto">
          ${txTableHTML()}
        </div>

        <!-- Interest rate log button -->
        <div style="padding:0 12px 80px">
          <div class="settings-card">
            <div class="settings-row" style="cursor:pointer" id="bg-rate-log-btn">
              <span class="settings-row-icon">📈</span>
              <span class="settings-row-label">Interest rate log</span>
              <span style="margin-left:auto;color:var(--text-2);font-size:13px">${currentRate != null ? currentRate + '% p.a.' : 'Not set'}</span>
              <span class="settings-row-chevron">›</span>
            </div>
            <div class="settings-row" style="cursor:pointer" id="bg-rename-btn">
              <span class="settings-row-icon">✏️</span>
              <span class="settings-row-label">Rename / archive account</span>
              <span class="settings-row-chevron">›</span>
            </div>
          </div>
        </div>
      `}
    </div>
  `;

  const screen = viewContainer.querySelector('#bg-screen');

  screen.querySelector('#bg-first-account')?.addEventListener('click', () => openBgAccountEditor(null, () => renderBankGilulu()));
  screen.querySelectorAll('[data-holding-id]').forEach(btn => {
    btn.addEventListener('click', () => renderBankGilulu(Number(btn.dataset.holdingId)));
  });
  screen.querySelector('#bg-add-account')?.addEventListener('click', () => openBgAccountEditor(null, () => renderBankGilulu()));
  screen.querySelector('#bg-add-tx-btn')?.addEventListener('click', () => {
    if (holding) openBgTxEditor(null, holding.id, () => renderBankGilulu(holding.id));
  });
  screen.querySelector('#bg-rate-log-btn')?.addEventListener('click', () => {
    openBgRateLogEditor(() => renderBankGilulu(holding?.id ?? null));
  });
  screen.querySelector('#bg-rename-btn')?.addEventListener('click', () => {
    if (holding) openBgAccountEditor(holding, () => renderBankGilulu());
  });
  screen.querySelectorAll('.bg-tx-row').forEach(row => {
    row.addEventListener('click', () => {
      const txId = Number(row.dataset.txId);
      const tx = allTxs.find(t => t.id === txId);
      if (tx) openBgTxEditor(tx, holding.id, () => renderBankGilulu(holding.id));
    });
  });

  // Balance over time chart
  const bgChartCanvas = screen.querySelector('#bg-chart');
  if (bgChartCanvas && allTxs.length > 0) {
    const sortedTxs = [...allTxs].sort((a, b) => a.date.localeCompare(b.date));
    const chartDates = [...new Set([...sortedTxs.map(t => t.date), toDate])].sort();
    const chartValues = chartDates.map(d => {
      const txsUpTo = sortedTxs.filter(t => t.date <= d);
      return bgTotalWithInterest(txsUpTo, ratePeriods, d);
    });
    const range = Math.max(...chartValues) - Math.min(...chartValues);
    const niceSteps = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000];
    const step = niceSteps.find(s => range / s <= 7) ?? 10000;
    new Chart(bgChartCanvas, {
      type: 'line',
      data: {
        labels: chartDates.map(d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' })),
        datasets: [{ data: chartValues, borderColor: '#1a73e8', backgroundColor: 'rgba(26,115,232,0.08)', fill: true, tension: 0.3, pointRadius: chartDates.length > 20 ? 2 : 4, pointBackgroundColor: '#1a73e8' }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => '£' + ctx.parsed.y.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } } },
        scales: {
          x: { ticks: { font: { size: 10 }, maxRotation: 45, minRotation: 45 }, grid: { display: false } },
          y: { ticks: { font: { size: 10 }, callback: v => bgFmt(v), stepSize: step }, grid: { color: 'rgba(0,0,0,.06)' } },
        },
      },
    });
  }
}

function openBgAccountEditor(existing, onDone) {
  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${existing ? 'Edit account' : 'New account'}</span>
        <button class="sheet-close" id="bgae-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group">
          <label class="form-label">Account holder name</label>
          <input class="form-input" id="bgae-name" type="text" placeholder="e.g. Dom" value="${existing?.name ?? ''}">
        </div>
        <div style="display:flex;gap:8px;padding-top:8px;padding-bottom:24px">
          ${existing ? `<button class="btn btn-danger" id="bgae-del">Archive</button>` : ''}
          <button class="btn btn-primary" id="bgae-save" style="flex:1">Save</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#bgae-close').onclick = () => overlay.remove();

  overlay.querySelector('#bgae-save').onclick = async () => {
    const name = overlay.querySelector('#bgae-name').value.trim();
    if (!name) { showToast('Enter a name'); return; }
    if (existing) {
      await db.friendHoldings.update(existing.id, { name });
      queueWrite('friendHoldings', existing.id).catch(() => {});
    } else {
      const id = await db.friendHoldings.add({ name, isActive: true, interestRate: null });
      queueWrite('friendHoldings', id).catch(() => {});
    }
    overlay.remove();
    onDone();
  };

  overlay.querySelector('#bgae-del')?.addEventListener('click', async () => {
    if (!confirm(`Archive ${existing.name}?`)) return;
    await db.friendHoldings.update(existing.id, { isActive: false });
    queueWrite('friendHoldings', existing.id).catch(() => {});
    overlay.remove();
    onDone();
  });
}

function openBgTxEditor(existing, holdingId, onDone) {
  const isNew = !existing;
  let pence = Math.round(Math.abs(existing?.amount ?? 0) * 100);
  let negative = (existing?.amount ?? 0) < 0;
  let currentDate = existing?.date ?? today();

  function getAmount() { return (negative ? -1 : 1) * pence / 100; }

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header" style="display:grid;grid-template-columns:44px 1fr 44px;align-items:center;padding:14px 12px">
        <button class="sheet-close" id="bgte-close" style="justify-self:start">✕</button>
        <span class="sheet-title" style="text-align:center">${isNew ? 'New deposit / withdrawal' : 'Edit transaction'}</span>
        <button id="bgte-save-hdr" style="justify-self:end;background:none;border:none;cursor:pointer;font-size:22px;font-weight:700;color:var(--blue);padding:4px">✓</button>
      </div>
      <div class="sheet-body" style="padding:12px 16px 0">
        <div class="form-group" style="margin-bottom:10px">
          <label class="form-label">Date</label>
          <input class="form-input" id="bgte-date" type="date" value="${currentDate}">
        </div>
        <div id="bgte-amount-display" style="font-size:36px;font-weight:800;text-align:center;padding:8px 0;color:${negative ? 'var(--coral)' : '#43a047'}">
          ${!negative ? '+' : ''}${bgFmt(getAmount())}
        </div>
        <div style="font-size:11px;color:var(--text-2);text-align:center;margin-bottom:8px">Positive = deposit · Negative = withdrawal</div>
        <div style="padding:0 0 6px;text-align:center">
          <button id="bgte-toggle" style="font-size:12px;padding:4px 12px;border-radius:20px;border:1.5px solid var(--border);background:transparent;color:var(--text-2);cursor:pointer">+/− toggle</button>
        </div>
        <div class="numpad" style="margin:0 -16px">
          ${['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(k => `<button class="numpad-key${k==='⌫'?' delete':''}" data-key="${k}">${k}</button>`).join('')}
        </div>
        ${!isNew ? `<button class="btn btn-danger" id="bgte-del-tx" style="width:100%;margin-top:8px;margin-bottom:12px">Delete transaction</button>` : '<div style="height:12px"></div>'}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  function refreshDisplay() {
    const a = getAmount();
    const disp = overlay.querySelector('#bgte-amount-display');
    if (!disp) return;
    disp.style.color = a < 0 ? 'var(--coral)' : '#43a047';
    disp.textContent = (a >= 0 ? '+' : '') + bgFmt(a);
  }

  async function doSave() {
    const date = overlay.querySelector('#bgte-date').value;
    if (!date) { showToast('Enter a date'); return; }
    const amount = getAmount();
    if (amount === 0) { showToast('Enter an amount'); return; }
    if (isNew) {
      const id = await db.friendTransactions.add({ holdingId, date, amount, isInterest: false });
      queueWrite('friendTransactions', id).catch(() => {});
    } else {
      await db.friendTransactions.update(existing.id, { date, amount });
      queueWrite('friendTransactions', existing.id).catch(() => {});
    }
    overlay.remove();
    onDone();
  }

  overlay.querySelector('#bgte-close').onclick = () => overlay.remove();
  overlay.querySelector('#bgte-save-hdr').onclick = doSave;
  overlay.querySelector('#bgte-date').addEventListener('change', () => {
    currentDate = overlay.querySelector('#bgte-date').value;
    if (getAmount() !== 0) doSave();
  });
  overlay.querySelectorAll('[data-key]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.key;
      if (k === '⌫') { pence = Math.floor(pence / 10); }
      else if (k !== '.') { pence = pence * 10 + Number(k); }
      refreshDisplay();
    });
  });
  overlay.querySelector('#bgte-toggle').addEventListener('click', () => { negative = !negative; refreshDisplay(); });
  overlay.querySelector('#bgte-del-tx')?.addEventListener('click', async () => {
    if (!confirm('Delete this transaction?')) return;
    await db.friendTransactions.delete(existing.id);
    queueDelete('friendTransactions', existing.id).catch(() => {});
    overlay.remove();
    onDone();
  });
}

async function openBgRateLogEditor(onDone) {
  let periods = (await getGlobalRatePeriods()).sort((a, b) => b.fromDate.localeCompare(a.fromDate)); // newest first

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  function build() {
    overlay.innerHTML = `
      <div class="sheet" style="max-height:85vh">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title">Interest rate log</span>
          <button class="sheet-close" id="bgrl-close">✕</button>
        </div>
        <div class="sheet-body" style="padding:16px;overflow-y:auto;max-height:calc(85vh - 60px)">
          <div style="font-size:13px;color:var(--text-2);margin-bottom:12px;line-height:1.5">Each entry sets the rate from that date onward until the next entry. Tap a rate to edit. Newest first.</div>
          ${periods.length === 0 ? `<div style="color:var(--text-2);font-size:13px;padding:8px 0">No rates set yet.</div>` : ''}
          ${periods.map((p, i) => `
            <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
              <input class="form-input bgrl-date" data-idx="${i}" type="date" value="${p.fromDate}" style="flex:1;font-size:13px;padding:6px 10px">
              <button class="bgrl-rate-btn" data-idx="${i}" style="font-size:14px;font-weight:600;padding:6px 12px;border-radius:var(--radius-sm);border:1px solid var(--border);background:var(--bg);cursor:pointer;min-width:70px">${p.rate}%</button>
              <button class="bgrl-del-btn" data-idx="${i}" style="padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--coral);font-size:13px;cursor:pointer">✕</button>
            </div>
          `).join('')}
          <button class="btn" id="bgrl-add" style="width:100%;border:1.5px dashed var(--border);background:transparent;color:var(--text-2);margin-top:4px">+ Add rate period</button>
          <button class="btn btn-primary btn-full" id="bgrl-save" style="margin-top:12px;margin-bottom:24px">Save</button>
        </div>
      </div>
    `;
    overlay.querySelector('#bgrl-close').onclick = () => overlay.remove();

    overlay.querySelectorAll('.bgrl-rate-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.idx);
        openAmountPad(`Rate from ${periods[i].fromDate}`, periods[i].rate, val => {
          periods[i].rate = Math.abs(val);
          build();
        }, { prefix: '', suffix: '%', noNegative: true, decimals: 2 });
      });
    });

    overlay.querySelectorAll('.bgrl-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        periods.splice(Number(btn.dataset.idx), 1);
        build();
      });
    });

    overlay.querySelector('#bgrl-add').addEventListener('click', () => {
      periods.unshift({ fromDate: today(), rate: periods[0]?.rate ?? 4 });
      build();
    });

    overlay.querySelector('#bgrl-save').onclick = async () => {
      // Read any edited dates before saving
      overlay.querySelectorAll('.bgrl-date').forEach(inp => {
        const i = Number(inp.dataset.idx);
        if (periods[i]) periods[i].fromDate = inp.value;
      });
      const sorted = [...periods].sort((a, b) => b.fromDate.localeCompare(a.fromDate));
      await setSetting('bgRatePeriods', JSON.stringify(sorted));
      queueWrite('settings', 'bgRatePeriods').catch(() => {});
      overlay.remove();
      onDone();
      showToast('Interest rate log saved');
    };
  }

  build();
}

async function renderSettings() {
  const activeSavings = await getSavingsTarget();
  const user = state.currentUser;
  const ss = syncState;
  const lastSync = await getSetting('lastSyncAt');
  const syncAgo = lastSync ? (() => {
    const diff = Math.round((Date.now() - lastSync) / 60000);
    if (diff < 1) return 'just now';
    if (diff < 60) return `${diff}m ago`;
    return `${Math.round(diff / 60)}h ago`;
  })() : null;

  const syncSection = `
    <div class="settings-section">
      <div class="settings-section-title">Sync</div>
      <div class="settings-card">
        ${user ? `
          <div class="settings-row" style="gap:12px">
            <img class="sync-avatar" src="${user.photoURL ?? ''}" alt="">
            <div style="flex:1;min-width:0">
              <div style="font-size:14px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user.displayName ?? user.email}</div>
              <div style="font-size:12px;color:var(--text-2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${user.email}</div>
            </div>
            ${ss.active ? `<span class="sync-chip sync-active">Syncing…</span>` :
              ss.error ? `<span class="sync-chip sync-error">Error</span>` :
              syncAgo ? `<span class="sync-chip sync-ok">Synced ${syncAgo}</span>` : ''}
          </div>
          <div class="settings-row" id="sync-now-btn"><span class="settings-row-icon">🔄</span><span class="settings-row-label">Sync now</span></div>
          <div class="settings-row" id="force-upload-btn"><span class="settings-row-icon">⬆️</span><span class="settings-row-label">Force re-upload all to cloud</span></div>
          <div class="settings-row" id="sign-out-btn" style="color:var(--red)"><span class="settings-row-icon">👋</span><span class="settings-row-label" style="color:var(--red)">Sign out</span></div>
        ` : `
          <div style="padding:4px 0 12px;font-size:13px;color:var(--text-2);line-height:1.6">Sign in to sync your data across devices automatically.</div>
          <button class="btn-google" id="google-signin-btn">
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.08 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-3.59-13.46-8.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
            Sign in with Google
          </button>
        `}
      </div>
    </div>
  `;

  viewContainer.innerHTML = `
    <div class="settings-screen">
      <div class="screen-header" style="padding-top:52px"><div style="width:34px"></div><span class="screen-title">Settings</span><div style="width:34px"></div></div>
      <div class="settings-section">
        <div class="settings-section-title">Income</div>
        <div class="settings-card">
          <div class="settings-row" id="nav-rec-income"><span class="settings-row-icon">💵</span><span class="settings-row-label">Recurring income</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-extra-incomes"><span class="settings-row-icon">💰</span><span class="settings-row-label">Extra incomes</span><span class="settings-row-chevron">›</span></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Costs</div>
        <div class="settings-card">
          <div class="settings-row" id="nav-recurring"><span class="settings-row-icon">🔄</span><span class="settings-row-label">Recurring expenses</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-distributions"><span class="settings-row-icon">📅</span><span class="settings-row-label">Big Expenses</span><span class="settings-row-chevron">›</span></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Savings</div>
        <div class="settings-card">
          <div class="settings-row" id="savings-target-row" style="cursor:pointer"><span class="settings-row-icon">💛</span><span class="settings-row-label">Savings targets</span><span style="color:var(--text-2);font-size:14px;margin-left:auto">${fmt(activeSavings)}/mo now</span><span class="settings-row-chevron">›</span></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Wealth</div>
        <div class="settings-card">
          <div class="settings-row" id="nav-net-wealth"><span class="settings-row-icon">📊</span><span class="settings-row-label">Net wealth tracker</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-bank-gilulu"><span class="settings-row-icon">🏦</span><span class="settings-row-label">Bank of Gilulu</span><span class="settings-row-chevron">›</span></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Data</div>
        <div class="settings-card">
          <div class="settings-row" id="nav-import"><span class="settings-row-icon">📥</span><span class="settings-row-label">Import data</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="export-btn"><span class="settings-row-icon">📤</span><span class="settings-row-label">Export data (JSON)</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="clear-btn" style="color:var(--red)"><span class="settings-row-icon">🗑️</span><span class="settings-row-label" style="color:var(--red)">Clear all data</span></div>
        </div>
      </div>
      ${syncSection}
      <div style="text-align:center;padding:20px;color:var(--text-2);font-size:12px">App updated: 26 Jul 2026 at 12:53 BST (v27)</div>
    </div>
  `;
  viewContainer.querySelector('#savings-target-row').onclick = () => openSavingsSheet();
  viewContainer.querySelector('#nav-rec-income').onclick = () => navigate('recurring', { recurringTab: 'income' });
  viewContainer.querySelector('#nav-extra-incomes').onclick = () => navigate('extraIncomes');
  viewContainer.querySelector('#nav-recurring').onclick = () => navigate('recurring', { recurringTab: 'expenses' });
  viewContainer.querySelector('#nav-distributions').onclick = () => navigate('distributions');
  viewContainer.querySelector('#nav-net-wealth').onclick = () => navigate('netWealth');
  viewContainer.querySelector('#nav-bank-gilulu').onclick = () => navigate('bankGilulu');
  viewContainer.querySelector('#nav-import').onclick = () => navigate('import');
  viewContainer.querySelector('#export-btn').onclick = exportData;
  viewContainer.querySelector('#clear-btn').onclick = async () => {
    if (!confirm('This will delete ALL local data permanently. Are you sure?')) return;
    if (!confirm('Really? This cannot be undone.')) return;
    await Promise.all([db.transactions.clear(), db.distributions.clear(), db.accountSnapshots.clear(), db.friendTransactions.clear()]);
    showToast('Data cleared'); navigate('balance');
  };
  const signinBtn = viewContainer.querySelector('#google-signin-btn');
  if (signinBtn) signinBtn.onclick = async () => { try { await signInWithGoogle(); } catch (e) { showToast('Sign-in failed: ' + e.message); } };
  const syncNowBtn = viewContainer.querySelector('#sync-now-btn');
  if (syncNowBtn) syncNowBtn.onclick = async () => { showToast('Syncing…'); await pullFromFirestore(); renderSettings(); };
  const forceUploadBtn = viewContainer.querySelector('#force-upload-btn');
  if (forceUploadBtn) forceUploadBtn.onclick = async () => {
    if (!confirm('This will overwrite cloud data with everything on this device. Use this on the device that has the most complete data. Continue?')) return;
    showToast('Uploading all data…');
    await uploadAllToFirestore();
    showToast('Upload complete — sync on other devices now');
    renderSettings();
  };
  const signOutBtn = viewContainer.querySelector('#sign-out-btn');
  if (signOutBtn) signOutBtn.onclick = async () => { await signOutUser(); renderSettings(); };
}

function renderImport() {
  viewContainer.innerHTML = `
    <div class="import-screen">
      <div class="screen-header" style="padding-top:52px">
        <button class="icon-btn" onclick="window.app.navigate('settings')"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
        <span class="screen-title">Import Data</span>
        <div style="width:34px"></div>
      </div>
      <div style="padding:16px">
        <p style="color:var(--text-2);font-size:14px;line-height:1.6;margin-bottom:16px">Import a <strong>migration-data.json</strong> file generated by the migration script. This will add data without overwriting existing records.</p>
        <div class="import-dropzone" id="dropzone">
          <div class="import-dropzone-icon">📂</div>
          <div class="import-dropzone-label">Select migration-data.json</div>
          <div class="import-dropzone-hint">Or drag and drop here</div>
          <input type="file" id="import-file" accept=".json" style="display:none">
        </div>
        <div id="import-progress" style="display:none;margin-top:16px">
          <div class="progress-bar-wrap"><div class="progress-bar-fill" id="prog-fill" style="width:0%"></div></div>
          <div id="prog-label" style="font-size:13px;color:var(--text-2);margin-top:4px">Starting...</div>
        </div>
        <div id="import-result" style="display:none;margin-top:16px"></div>
      </div>
      <div style="padding:0 16px">
        <div style="background:var(--card);border-radius:var(--radius);padding:14px;font-size:13px;color:var(--text-2);line-height:1.7">
          <strong>To generate migration-data.json:</strong><br>
          1. Download the repo and locate <code>migrate/extract.py</code><br>
          2. Run: <code>python3 extract.py</code><br>
          3. This produces <code>migration-data.json</code> - import it here
        </div>
      </div>
    </div>
  `;
  const dropzone = viewContainer.querySelector('#dropzone');
  const fileInput = viewContainer.querySelector('#import-file');
  dropzone.onclick = () => fileInput.click();
  fileInput.onchange = e => handleImportFile(e.target.files[0]);
  dropzone.ondragover = e => { e.preventDefault(); dropzone.classList.add('drag-over'); };
  dropzone.ondragleave = () => dropzone.classList.remove('drag-over');
  dropzone.ondrop = e => { e.preventDefault(); dropzone.classList.remove('drag-over'); handleImportFile(e.dataTransfer.files[0]); };
}

async function handleImportFile(file) {
  if (!file) return;
  const progress = viewContainer.querySelector('#import-progress');
  const progFill = viewContainer.querySelector('#prog-fill');
  const progLabel = viewContainer.querySelector('#prog-label');
  const resultDiv = viewContainer.querySelector('#import-result');
  progress.style.display = 'block';
  resultDiv.style.display = 'none';
  try {
    const data = JSON.parse(await file.text());
    const stats = { transactions: 0, categories: 0, recurringExpenses: 0, recurringIncome: 0, savingsTargets: 0, distributions: 0, accountSnapshots: 0, friendHoldings: 0, friendTransactions: 0 };
    const step = async (label, pct, fn) => { progLabel.textContent = label; progFill.style.width = pct + '%'; await fn(); await new Promise(r => setTimeout(r, 10)); };
    await step('Importing categories...', 10, async () => { if (data.categories?.length) { await db.categories.bulkPut(data.categories); stats.categories = data.categories.length; } });
    await step('Importing transactions...', 30, async () => {
      if (data.transactions?.length) {
        for (let i = 0; i < data.transactions.length; i += 500) {
          await db.transactions.bulkPut(data.transactions.slice(i, i + 500));
          progLabel.textContent = `Importing transactions... ${Math.min(i + 500, data.transactions.length)}/${data.transactions.length}`;
        }
        stats.transactions = data.transactions.length;
      }
    });
    await step('Importing recurring expenses...', 50, async () => { if (data.recurringExpenses?.length) { await db.recurringExpenses.bulkPut(data.recurringExpenses); stats.recurringExpenses = data.recurringExpenses.length; } });
    await step('Importing recurring income...', 60, async () => { if (data.recurringIncome?.length) { await db.recurringIncome.bulkPut(data.recurringIncome); stats.recurringIncome = data.recurringIncome.length; } });
    await step('Importing savings targets...', 65, async () => { if (data.savingsTargets?.length) { await db.savingsTargets.bulkPut(data.savingsTargets); stats.savingsTargets = data.savingsTargets.length; } });
    await step('Importing distributions...', 70, async () => { if (data.distributions?.length) { await db.distributions.bulkPut(data.distributions); stats.distributions = data.distributions.length; } });
    await step('Importing account snapshots...', 80, async () => { if (data.accountSnapshots?.length) { await db.accountSnapshots.bulkPut(data.accountSnapshots); stats.accountSnapshots = data.accountSnapshots.length; } });
    await step('Importing friend data...', 90, async () => {
      if (data.friendHoldings?.length) { await db.friendHoldings.bulkPut(data.friendHoldings); stats.friendHoldings = data.friendHoldings.length; }
      if (data.friendTransactions?.length) { await db.friendTransactions.bulkPut(data.friendTransactions); stats.friendTransactions = data.friendTransactions.length; }
    });
    progFill.style.width = '100%'; progLabel.textContent = 'Complete!';
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = `
      <div style="background:#e8f5e9;border-radius:var(--radius-sm);padding:14px;font-size:13px;line-height:1.8">
        <strong>Import successful</strong><br>
        ${Object.entries(stats).filter(([,v]) => v > 0).map(([k, v]) => `${v} ${k}`).join('<br>')}
      </div>
      <button class="btn btn-primary btn-full" style="margin-top:12px" onclick="window.app.navigate('balance')">Go to Balance</button>
    `;
  } catch (err) {
    progress.style.display = 'none';
    resultDiv.style.display = 'block';
    resultDiv.innerHTML = `<div style="background:#ffebee;border-radius:var(--radius-sm);padding:14px;font-size:13px;color:var(--red)">Error: ${err.message}</div>`;
  }
}

async function exportData() {
  showToast('Preparing export...');
  const [transactions, categories, recurringExpenses, recurringIncome, savingsTargets, distributions, accounts, accountSnapshots, friendHoldings, friendTransactions] = await Promise.all([
    db.transactions.toArray(), db.categories.toArray(), db.recurringExpenses.toArray(), db.recurringIncome.toArray(),
    db.savingsTargets.toArray(), db.distributions.toArray(), db.accounts.toArray(),
    db.accountSnapshots.toArray(), db.friendHoldings.toArray(), db.friendTransactions.toArray(),
  ]);
  const data = { transactions, categories, recurringExpenses, recurringIncome, savingsTargets, distributions, accounts, accountSnapshots, friendHoldings, friendTransactions, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = `pocket-ledger-backup-${today()}.json`; a.click();
  URL.revokeObjectURL(url);
  showToast('Export downloaded');
}

async function runDataMigrations() {
  const ver = (await getSetting('dataVersion')) ?? 0;
  if (ver < 1) {
    // Unarchive Investment category so it's selectable for extra incomes
    await db.categories.update(21, { isArchived: false, sortOrder: 15 });

    // Convert recurringIncome from intervalDays to frequency
    const incomes = await db.recurringIncome.toArray();
    for (const r of incomes) {
      if (!r.frequency) {
        let freq = 'monthly';
        if (r.intervalDays >= 85 && r.intervalDays <= 100) freq = 'quarterly';
        else if (r.intervalDays >= 300) freq = 'yearly';
        await db.recurringIncome.update(r.id, { frequency: freq });
      }
    }

    // Fix all imported distributions: extraction script set isIncome=true for all
    // (amounts in ZWISH are always positive), but they are all expenses
    const dists = await db.distributions.toArray();
    const badDists = dists.filter(d => !!d.isIncome);
    for (let i = 0; i < badDists.length; i += 50) {
      await Promise.all(badDists.slice(i, i + 50).map(async d => {
        await db.distributions.update(d.id, { isIncome: false });
        try { await queueWrite('distributions', d.id); } catch {}
      }));
    }

    await setSetting('dataVersion', 1);
  }

  if (ver < 2) {
    // Rename "Expenses reimbursement" → "Expenses" in db.categories
    const cat = await db.categories.get(14);
    if (cat && cat.name === 'Expenses reimbursement') {
      await db.categories.update(14, { name: 'Expenses' });
      try { await queueWrite('categories', 14); } catch {}
    }
    await setSetting('dataVersion', 2);
  }

  if (ver < 3) {
    // Mark done immediately so app isn't blocked; heavy work runs in background
    await setSetting('dataVersion', 3);
    // Regenerate missing children asynchronously after app renders
    setTimeout(async () => {
      try {
        const allDists = await db.distributions.toArray();
        for (const dist of allDists) {
          const childCount = await db.transactions.where('distributionId').equals(dist.id).count();
          if (childCount === 0 && dist.startDate && dist.endDate) {
            const children = generateDistributionChildren(dist);
            await db.transactions.bulkAdd(children);
            // Fire Firestore writes without awaiting — offline persistence retries automatically
            const newChildren = await db.transactions.where('distributionId').equals(dist.id).toArray();
            newChildren.forEach(c => queueWrite('transactions', c.id).catch(() => {}));
          }
        }
      } catch (e) {
        console.warn('Distribution child migration failed:', e);
      }
    }, 2000);
  }

  if (ver < 4) {
    await setSetting('dataVersion', 4);
    const existing = await db.categories.get(28);
    if (!existing) {
      await db.categories.add({ id: 28, name: 'Misc', icon: '📦', colour: '#9E9E9E', isIncome: false, sortOrder: 13, isArchived: false });
      queueWrite('categories', 28).catch(() => {});
    }
  }

  if (ver < 5) {
    await setSetting('dataVersion', 5);
    await db.accounts.update(13, { isAsset: false });
    queueWrite('accounts', 13).catch(() => {});
  }

  if (ver < 6) {
    await setSetting('dataVersion', 6);
    // Fix snapshots incorrectly dated 2026-01-01 → should be 2026-02-01
    const wrongSnaps = await db.accountSnapshots.filter(s => s.date === '2026-01-01').toArray();
    for (const s of wrongSnaps) {
      await db.accountSnapshots.update(s.id, { date: '2026-02-01' });
      queueWrite('accountSnapshots', s.id).catch(() => {});
    }
  }

  if (ver < 7) {
    await setSetting('dataVersion', 7);
    // Normalize friendHoldings: ensure `name` field is set from alternative field names
    const fh = await db.friendHoldings.toArray();
    for (const h of fh) {
      if (!h.name) {
        const name = h.person ?? h.holder ?? h.label ?? h.account ?? null;
        if (name) {
          await db.friendHoldings.update(h.id, { name });
          queueWrite('friendHoldings', h.id).catch(() => {});
        }
      }
      // Seed default interest rate periods from legacy interestRate field
      if (h.interestRate != null && !h.ratePeriods) {
        await db.friendHoldings.update(h.id, {
          ratePeriods: JSON.stringify([{ fromDate: '2020-01-01', rate: h.interestRate }]),
        });
        queueWrite('friendHoldings', h.id).catch(() => {});
      }
    }
  }

  if (ver < 8) {
    await setSetting('dataVersion', 8);
    // Migrate per-holding ratePeriods to a single global setting
    const existing = await getSetting('bgRatePeriods');
    if (!existing) {
      const fh = await db.friendHoldings.toArray();
      for (const h of fh) {
        if (h.ratePeriods) {
          try {
            const periods = JSON.parse(h.ratePeriods);
            if (periods.length > 0) {
              await setSetting('bgRatePeriods', JSON.stringify(periods));
              queueWrite('settings', 'bgRatePeriods').catch(() => {});
              break;
            }
          } catch {}
        }
      }
    }
  }
}

async function init() {
  await initDB();
  await runDataMigrations();
  await handleRedirectResult();
  navBtns.forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.view)));
  initSync(user => {
    state.currentUser = user;
    if (state.view === 'settings') renderSettings();
  });
  onSync(() => {
    if (state.view === 'settings') renderSettings();
  });
  navigate('balance');
}

window.app = { navigate };
init().catch(console.error);
