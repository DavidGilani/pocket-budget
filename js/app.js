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
  txnFilter: 'all',
  recurringTab: 'expenses',
  analysisPeriod: 'month',
  analysisViewingCycle: null,
  viewingCycle: null,
  pendingSync: 0,
  currentUser: null,
  txnMonth: null,
};

const viewContainer = document.getElementById('view');
const navBtns = document.querySelectorAll('.nav-btn');

function navigate(view, params = {}) {
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
      case 'recurring':    await renderRecurring(); break;
      case 'distributions':await renderDistributions(); break;
      case 'extraIncomes': await renderExtraIncomes(); break;
      case 'accounts':     await renderAccounts(); break;
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

  viewContainer.innerHTML = `
    <div class="balance-screen ${todayBal < 0 ? 'negative' : ''}">
      ${pendingCount > 0 ? `<div class="sync-banner">${pendingCount} change${pendingCount > 1 ? 's' : ''} pending sync</div>` : ''}
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
        ${projections.map((p, i) => `
          <div class="proj-day">
            <div class="proj-bar-wrap">
              <div class="proj-bar" style="height:${Math.max(20, Math.round(Math.abs(p.balance) / maxBal * 80))}px">
                ${segments(p.balance)}
              </div>
            </div>
            <div class="proj-divider"></div>
            <div class="proj-label">${dayLabels[i]}</div>
            <div class="proj-amount">${fmt(p.balance)}</div>
          </div>
        `).join('')}
      </div>

      <div class="balance-fabs">
        <button class="fab fab-income" id="fab-income" aria-label="Add income">+</button>
        <button class="fab fab-expense" id="fab-expense" aria-label="Add expense">-</button>
      </div>
    </div>
  `;

  viewContainer.querySelector('#fab-income').onclick = () => openEntry('income');
  viewContainer.querySelector('#fab-expense').onclick = () => openEntry('expense');
  viewContainer.querySelector('#balance-menu-btn').onclick = () => navigate('settings');
  viewContainer.querySelector('#balance-cycle-btn').onclick = () => navigate('breakdown');
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
        <span class="sheet-title">${existingTxn ? 'Edit' : 'Add'} ${type === 'income' ? 'Income' : 'Expense'}</span>
        <button class="sheet-close" id="entry-close">✕</button>
      </div>
      <div class="sheet-body">
        <div class="entry-amount-display ${type} ${state.entryPence === 0 ? 'placeholder' : ''}" id="entry-display">
          ${state.entryPence > 0 ? fmt(state.entryPence / 100) : '£0.00'}
        </div>

        <div class="entry-field cat-collapsed-row" id="cat-collapsed" style="${hasCategory ? '' : 'display:none'}">
          <span class="entry-field-icon">🏷️</span>
          <label>Category</label>
          <div id="cat-preview" style="flex:1;font-size:15px;color:var(--text)">
            ${hasCategory ? `<span style="margin-right:4px">${selectedCat.icon}</span>${selectedCat.name}` : ''}
          </div>
          <span style="color:var(--text-2);font-size:18px">›</span>
        </div>

        <div class="cat-grid" id="cat-grid" style="${hasCategory ? 'display:none' : ''}">
          ${cats.map(c => `
            <div class="cat-item ${state.entryCategory === c.id ? 'selected' : ''}"
                 data-cat="${c.id}" data-cat-name="${c.name}" data-cat-icon="${c.icon}">
              <div class="cat-icon" style="background:${c.colour}20; color:${c.colour}">
                ${c.icon}
              </div>
              <div class="cat-name">${c.name}</div>
            </div>
          `).join('')}
        </div>

        <div class="entry-fields">
          <div class="entry-field">
            <span class="entry-field-icon">📅</span>
            <label>Date</label>
            <input type="date" id="entry-date" value="${state.entryDate}" max="${today()}">
          </div>
          <div class="entry-field">
            <span class="entry-field-icon">📝</span>
            <label>Note</label>
            <input type="text" id="entry-note" placeholder="Optional note" value="${state.entryNote}" maxlength="200">
          </div>
        </div>
      </div>

      <div class="numpad">
        ${['1','2','3','4','5','6','7','8','9','.','0','⌫'].map(k => `
          <button class="numpad-key ${k === '⌫' ? 'delete' : ''}" data-key="${k}">${k}</button>
        `).join('')}
        <button class="numpad-key action" id="entry-save" style="grid-column: 1 / -1">
          ${existingTxn ? 'Update' : 'Save'}
        </button>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeEntry(); });
  overlay.querySelector('#entry-close').onclick = closeEntry;

  overlay.querySelector('#cat-collapsed').onclick = () => {
    overlay.querySelector('#cat-collapsed').style.display = 'none';
    overlay.querySelector('#cat-grid').style.display = '';
  };

  delegate(overlay, 'click', '.cat-item', (e, el) => {
    overlay.querySelectorAll('.cat-item').forEach(i => i.classList.remove('selected'));
    el.classList.add('selected');
    state.entryCategory = Number(el.dataset.cat);
    overlay.querySelector('#cat-preview').innerHTML = `<span style="margin-right:4px">${el.dataset.catIcon}</span>${el.dataset.catName}`;
    overlay.querySelector('#cat-grid').style.display = 'none';
    overlay.querySelector('#cat-collapsed').style.display = 'flex';
  });

  delegate(overlay, 'click', '.numpad-key', (e, el) => {
    const key = el.dataset.key;
    if (key === '⌫') {
      state.entryPence = Math.floor(state.entryPence / 10);
    } else if (key === '.') {
      // no-op in smart pence mode — digits auto-fill from right
    } else {
      const next = state.entryPence * 10 + parseInt(key);
      if (next <= 9999999) state.entryPence = next;
    }
    updateAmountDisplay(overlay);
  });

  overlay.querySelector('#entry-date').onchange = e => { state.entryDate = e.target.value; };
  overlay.querySelector('#entry-note').oninput = e => { state.entryNote = e.target.value; };
  overlay.querySelector('#entry-save').onclick = () => saveEntry(overlay);
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

function closeEntry() {
  const overlay = document.getElementById('entry-overlay');
  if (overlay) overlay.remove();
}

async function saveEntry(overlay) {
  const amount = state.entryPence / 100;
  if (!amount || amount <= 0) { showToast('Enter an amount'); return; }
  if (!state.entryCategory) { showToast('Select a category'); return; }

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
  let txns = await db.transactions
    .where('date').between(monthStart, monthEnd, true, true)
    .filter(t => ['expense', 'income', 'distributed_expense', 'distributed_income'].includes(t.type))
    .toArray();

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
  const dates = Object.keys(groups).sort((a, b) => b.localeCompare(a));

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
        <button class="icon-btn" onclick="window.app.navigate('balance')">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="screen-title">Transactions</span>
        <button class="icon-btn" id="txn-add-btn">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </button>
      </div>
      <button id="month-picker-btn" style="display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:var(--card);border:none;border-bottom:1px solid var(--border);width:100%;cursor:pointer;font-size:15px;color:var(--text)">
        <span style="font-weight:500">${monthLabel}</span>
        <span style="display:flex;align-items:center;gap:6px;color:var(--text-2);font-size:13px">
          ${txns.length > 0 ? `<span style="color:${monthTotal >= 0 ? 'var(--green)' : 'var(--red)'}">${monthTotal >= 0 ? '+' : ''}${fmt(monthTotal)}</span>` : ''}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>
        </span>
      </button>
      <div class="search-bar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        <input type="text" id="txn-search" placeholder="Search transactions..." value="${state.txnSearchQuery}" style="flex:1;border:none;outline:none;font-size:15px;background:none">
      </div>
      <div id="txn-list-body">
        ${dates.length === 0 ? `
          <div class="empty-state"><div class="empty-icon">📋</div><div class="empty-title">No transactions in ${monthLabel}</div><div class="empty-text">Tap + to add a transaction</div></div>
        ` : dates.map(date => {
          const dayTxns = groups[date];
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
                ${budgetRow}
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
                    </div>
                  `;
                }).join('')}
              </div>
              <div class="day-total"><div class="day-total-amount">${fmt(dayTotal)}</div></div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  const txnScreen = viewContainer.querySelector('.transactions-screen');
  txnScreen.querySelector('#txn-add-btn').onclick = () => openEntry('expense');
  txnScreen.querySelector('#txn-search').oninput = e => { state.txnSearchQuery = e.target.value; renderTransactions(); };
  txnScreen.querySelector('#month-picker-btn').onclick = () => showMonthPicker();
  delegate(txnScreen, 'click', '.txn-row', (e, el) => showTxnMenu(Number(el.dataset.txnId)));
  delegate(txnScreen, 'click', '.day-add-btn', (e, el) => { state.entryDate = el.dataset.date; openEntry('expense'); });
}

async function showMonthPicker() {
  const allTxns = await db.transactions
    .filter(t => ['expense', 'income', 'distributed_expense', 'distributed_income'].includes(t.type))
    .toArray();
  const monthTotals = {};
  for (const t of allTxns) {
    const mk = t.date.slice(0, 7);
    if (!monthTotals[mk]) monthTotals[mk] = 0;
    monthTotals[mk] += t.amount;
  }
  const months = Object.keys(monthTotals).sort((a, b) => b.localeCompare(a));
  const currentKey = state.txnMonth ?? today().slice(0, 7);

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
        ${months.map(mk => {
          const [y, m] = mk.split('-').map(Number);
          const label = new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
          const total = monthTotals[mk];
          const isSel = mk === currentKey;
          return `<div class="settings-row month-pick-row" data-month="${mk}" style="${isSel ? 'color:var(--blue)' : ''}">
            <span style="flex:1;font-size:15px">${label}</span>
            <span style="font-size:13px;color:${total >= 0 ? 'var(--green)' : 'var(--red)'}">Duration: ${new Date(y, m, 0).getDate()} days, ${fmt(total)}</span>
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
  overlay.querySelector('#txn-edit-btn').onclick = async () => { overlay.remove(); openEntry(txn.amount >= 0 ? 'income' : 'expense', txn); };
  overlay.querySelector('#txn-del-btn').onclick = async () => {
    if (txn.distributionId) { showToast('Edit the parent distribution to modify this entry'); overlay.remove(); return; }
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

  const rows = [
    { icon: '💰', bg: '#e8f5e9', label: 'Income', amount: bd.totalIncome, amountClass: 'text-green',
      subs: [{ label: 'Regular income', amount: bd.regularIncome }, { label: 'Variable income', amount: bd.variableIncome }] },
    { icon: '🛒', bg: '#ffebee', label: 'Expenses', amount: bd.totalExpenses, amountClass: 'text-red',
      subs: [{ label: 'Recurring expenses', amount: bd.recurringExpenses }, { label: 'Variable expenses', amount: bd.variableExpenses }, { label: 'Big Expenses', amount: bd.distributionExpenses }] },
    { icon: '💛', bg: '#fffde7', label: 'Savings', amount: bd.savings, amountClass: '', subs: [] },
    { icon: '📊', bg: '#e3f2fd', label: 'Budget left', amount: bd.budgetLeft, amountClass: bd.budgetLeft >= 0 ? 'text-green' : 'text-red', subs: [] },
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
              <div class="breakdown-row-amount ${row.amountClass}">${fmt(Math.abs(row.amount))}</div>
            </div>
            ${row.subs.filter(s => s.amount !== 0).map(s => `
              <div class="breakdown-sub-rows">
                <div class="breakdown-sub-row">
                  <span class="breakdown-sub-label">${s.label}</span>
                  <span class="breakdown-sub-amount">${fmt(Math.abs(s.amount))}</span>
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
  const cycle = await getCurrentCycle();
  let items;
  if (tab === 'expenses') {
    items = await db.recurringExpenses
      .filter(r => r.isActive && r.startDate <= cycle.end && (r.endDate == null || r.endDate >= cycle.start || r.endDate === '4001-01-01'))
      .toArray();
  } else {
    items = await db.recurringIncome
      .filter(r => r.isActive && r.startDate <= cycle.end && (r.endDate == null || r.endDate >= cycle.start || r.endDate === '4001-01-01'))
      .toArray();
  }

  items.sort((a, b) => monthlyEquivalent(b.amount ?? 0, b.frequency ?? 'monthly') - monthlyEquivalent(a.amount ?? 0, a.frequency ?? 'monthly'));

  const cycleLen = diffDays(cycle.start, cycle.end) + 1;
  const totalMonthly = items.reduce((s, r) => s + monthlyEquivalent(r.amount ?? 0, r.frequency ?? 'monthly'), 0);
  const totalDaily = totalMonthly / cycleLen;

  const formatMeta = r => {
    const start = r.startDate ? fmtDate(r.startDate) : '-';
    const end = (!r.endDate || r.endDate === '4001-01-01') ? 'open end' : fmtDate(r.endDate);
    const freq = (r.frequency ?? 'monthly').charAt(0).toUpperCase() + (r.frequency ?? 'monthly').slice(1);
    return `${fmt(r.amount)} (${freq}) ${start} - ${end}`;
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
              <div class="recurring-card-daily">${fmt(dailyEquivalent(r.amount, r.frequency ?? 'monthly', cycleLen))}<span style="font-size:14px;font-weight:400"> /day</span></div>
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  const recScreen = viewContainer.firstElementChild;
  recScreen.querySelector('#tab-exp').onclick = () => { state.recurringTab = 'expenses'; renderRecurring(); };
  recScreen.querySelector('#tab-inc').onclick = () => { state.recurringTab = 'income'; renderRecurring(); };
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
  const cycle = await getCurrentCycle();
  const txns = await db.transactions
    .where('date').between(cycle.start, cycle.end, true, true)
    .filter(t => t.type === 'expense' || t.type === 'distributed_expense')
    .toArray();
  const cats = await db.categories.toArray();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));
  const byCat = {};
  let totalSpend = 0;
  for (const t of txns) {
    if (!byCat[t.categoryId]) byCat[t.categoryId] = 0;
    byCat[t.categoryId] += Math.abs(t.amount);
    totalSpend += Math.abs(t.amount);
  }
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 10);
  const days = [];
  let d = cycle.start;
  while (d <= today() && d <= cycle.end) { days.push(d); d = addDays(d, 1); }
  const dailyData = await Promise.all(days.map(async day => { const { balance } = await calcRollingBalance(day); return { day, balance }; }));

  viewContainer.innerHTML = `
    <div class="analysis-screen">
      <div class="screen-header" style="padding-top:52px"><div style="width:34px"></div><span class="screen-title">Analysis</span><div style="width:34px"></div></div>
      <div style="padding:8px 12px 4px;font-size:12px;color:var(--text-2);text-align:center">${fmtDate(cycle.start)} - ${fmtDate(cycle.end)}</div>
      <div class="analysis-section">
        <div class="analysis-section-title">Rolling balance this month</div>
        <div class="chart-wrap"><canvas id="chart-balance"></canvas></div>
      </div>
      <div class="analysis-section">
        <div class="analysis-section-title">Spending by category (this month)</div>
        ${catRows.length === 0 ? '<div class="empty-state" style="padding:20px 0"><div class="empty-text">No spending data yet</div></div>' : ''}
        ${catRows.map(([cid, total]) => {
          const cat = catMap[cid];
          const pct = totalSpend > 0 ? (total / totalSpend * 100) : 0;
          return `<div class="cat-bar-row"><span class="cat-bar-label">${cat?.name ?? 'Other'}</span><div class="cat-bar-track"><div class="cat-bar-fill" style="width:${pct}%;background:${cat?.colour ?? '#ccc'}"></div></div><span class="cat-bar-amount">${fmt(total)}</span></div>`;
        }).join('')}
        ${totalSpend > 0 ? `<div style="text-align:right;margin-top:8px;font-size:13px;color:var(--text-2)">Total: <strong>${fmt(totalSpend)}</strong></div>` : ''}
      </div>
      <div class="analysis-section" style="margin-bottom:80px">
        <div class="analysis-section-title">Month-on-month (last 6 months)</div>
        <div class="chart-wrap"><canvas id="chart-mom"></canvas></div>
      </div>
    </div>
  `;

  new Chart(viewContainer.querySelector('#chart-balance').getContext('2d'), {
    type: 'line',
    data: {
      labels: dailyData.map(d => new Date(d.day + 'T12:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })),
      datasets: [{ data: dailyData.map(d => d.balance), borderColor: '#1a73e8', backgroundColor: 'rgba(26,115,232,0.1)', borderWidth: 2, fill: true, tension: 0.4, pointRadius: 0 }],
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 6, font: { size: 11 } } }, y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 11 }, callback: v => `£${(v/1000).toFixed(0)}k` } } } },
  });

  const months = [];
  for (let i = 5; i >= 0; i--) {
    const dt = new Date(); dt.setDate(1); dt.setMonth(dt.getMonth() - i);
    const ms = isoDate(dt);
    const me = isoDate(new Date(dt.getFullYear(), dt.getMonth() + 1, 0));
    const mTxns = await db.transactions.where('date').between(ms, me, true, true).filter(t => t.type === 'expense' || t.type === 'distributed_expense').toArray();
    months.push({ label: dt.toLocaleDateString('en-GB', { month: 'short' }), total: mTxns.reduce((s, t) => s + Math.abs(t.amount), 0) });
  }

  new Chart(viewContainer.querySelector('#chart-mom').getContext('2d'), {
    type: 'bar',
    data: { labels: months.map(m => m.label), datasets: [{ data: months.map(m => m.total), backgroundColor: months.map((_, i) => i === 5 ? '#1a73e8' : 'rgba(26,115,232,0.35)'), borderRadius: 6 }] },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ticks: { font: { size: 11 } } }, y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 11 }, callback: v => `£${v}` } } } },
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
  const active = dists.filter(d => !d.isFinished).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const finished = dists.filter(d => d.isFinished).sort((a, b) => b.endDate.localeCompare(a.endDate));
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
  const active = dists.filter(d => !d.isFinished).sort((a, b) => a.startDate.localeCompare(b.startDate));
  const finished = dists.filter(d => d.isFinished).sort((a, b) => b.endDate.localeCompare(a.endDate));
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
  const [savings, cycle] = await Promise.all([getSetting('savingsAmount') ?? 1500, getCurrentCycle()]);
  const { monthlyIncome, monthlyExpenses } = await calcDailyAllowance(cycle.start, cycle.end);
  const takeHome = monthlyIncome - monthlyExpenses;

  const pctIncome = monthlyIncome > 0 ? ((savings / monthlyIncome) * 100).toFixed(1) : 0;
  const pctTakeHome = takeHome > 0 ? ((savings / takeHome) * 100).toFixed(1) : 0;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header"><span class="sheet-title">Monthly Savings Target</span><button class="sheet-close" id="sav-close">✕</button></div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group">
          <label class="form-label">Target amount (£)</label>
          <input class="form-input" id="sav-amount" type="number" step="50" min="0" value="${savings}" placeholder="0">
        </div>
        <div id="sav-stats" style="background:var(--bg);border-radius:var(--radius-sm);padding:14px;margin-top:4px;font-size:13px;line-height:2;color:var(--text-2)">
          <div style="display:flex;justify-content:space-between"><span>% of monthly income</span><span style="color:var(--text);font-weight:600">${pctIncome}%</span></div>
          <div style="display:flex;justify-content:space-between"><span>% of take-home (after expenses)</span><span style="color:var(--text);font-weight:600">${pctTakeHome}%</span></div>
          <div style="display:flex;justify-content:space-between"><span>Monthly income</span><span>${fmt(monthlyIncome)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>Monthly expenses</span><span>${fmt(monthlyExpenses)}</span></div>
          <div style="display:flex;justify-content:space-between"><span>Take-home</span><span>${fmt(takeHome)}</span></div>
        </div>
        <button class="btn btn-primary btn-full" id="sav-save" style="margin-top:16px;margin-bottom:20px">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#sav-close').onclick = () => overlay.remove();

  const amtInput = overlay.querySelector('#sav-amount');
  const statsDiv = overlay.querySelector('#sav-stats');
  amtInput.oninput = () => {
    const v = parseFloat(amtInput.value) || 0;
    const pi = monthlyIncome > 0 ? ((v / monthlyIncome) * 100).toFixed(1) : 0;
    const pt = takeHome > 0 ? ((v / takeHome) * 100).toFixed(1) : 0;
    statsDiv.innerHTML = `
      <div style="display:flex;justify-content:space-between"><span>% of monthly income</span><span style="color:var(--text);font-weight:600">${pi}%</span></div>
      <div style="display:flex;justify-content:space-between"><span>% of take-home (after expenses)</span><span style="color:var(--text);font-weight:600">${pt}%</span></div>
      <div style="display:flex;justify-content:space-between"><span>Monthly income</span><span>${fmt(monthlyIncome)}</span></div>
      <div style="display:flex;justify-content:space-between"><span>Monthly expenses</span><span>${fmt(monthlyExpenses)}</span></div>
      <div style="display:flex;justify-content:space-between"><span>Take-home</span><span>${fmt(takeHome)}</span></div>
    `;
  };
  overlay.querySelector('#sav-save').onclick = async () => {
    const v = parseFloat(amtInput.value);
    if (isNaN(v) || v < 0) { showToast('Enter a valid amount'); return; }
    await setSetting('savingsAmount', v);
    try { await queueWrite('settings', 'savingsAmount'); } catch {}
    overlay.remove();
    showToast('Savings target updated');
    if (state.view === 'settings') renderSettings();
  };
}

async function renderSettings() {
  const savings = await getSetting('savingsAmount') ?? 1500;
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
          <div class="settings-row" id="savings-target-row" style="cursor:pointer"><span class="settings-row-icon">💛</span><span class="settings-row-label">Monthly savings target</span><span style="color:var(--text-2);font-size:14px;margin-left:auto">${fmt(savings)}</span><span class="settings-row-chevron">›</span></div>
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
      <div style="text-align:center;padding:20px;color:var(--text-2);font-size:12px">Pocket Ledger - Personal Finance<br>Data stored locally on this device</div>
    </div>
  `;
  viewContainer.querySelector('#savings-target-row').onclick = () => openSavingsSheet();
  viewContainer.querySelector('#nav-rec-income').onclick = () => navigate('recurring', { recurringTab: 'income' });
  viewContainer.querySelector('#nav-extra-incomes').onclick = () => navigate('extraIncomes');
  viewContainer.querySelector('#nav-recurring').onclick = () => navigate('recurring', { recurringTab: 'expenses' });
  viewContainer.querySelector('#nav-distributions').onclick = () => navigate('distributions');
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
}

async function init() {
  await initDB();
  await runDataMigrations();
  await handleRedirectResult();
  navBtns.forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.view)));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
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
