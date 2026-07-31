// Pocket Ledger - Main application

import { db, initDB, getSetting, setSetting } from './db.js';
import { fmt, fmtDate, fmtDateShort, dayName, today, isoDate, addDays, diffDays, cycleForDate, monthlyEquivalent, dailyEquivalent, delegate } from './utils.js';
import { calcRollingBalance, calcProjectedBalances, getCurrentCycle, getCycleForDate, calcDailyAllowance, getCycleBreakdown, generateDistributionChildren, getSavingsTarget } from './engine.js';
import { signInWithGoogle, handleRedirectResult, signOutUser, auth } from './firebase.js';
import { initSync, queueWrite, queueDelete, syncState, onSync, pullFromFirestore, uploadAllToFirestore, flushSyncQueue, getPendingSyncCount, downloadAllFromCloud, getCloudCounts, pingFirestore, getLastUploadReport } from './sync.js';

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
  householdBillsMonth: null,
  yearlyTrendsYear: null,
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

// Remember scroll position per view, so returning to a screen (e.g. Settings)
// restores where you were rather than jumping back to the top.
const scrollPositions = {};

// Back stack: every forward navigation records the view we came from, so the
// top-left "‹" back button returns to wherever the user actually arrived from
// (e.g. Settings vs the Daily Budget summary), not a hardcoded destination.
const navStack = [];

// Where a page's back button lands when the stack is empty (e.g. the app was
// opened directly onto it, or state was reset).
const BACK_FALLBACK = {
  breakdown: 'balance', yearlyTrends: 'analysis',
};
const backFallbackFor = view => BACK_FALLBACK[view] ?? 'settings';

function navigate(view, params = {}, isBack = false) {
  // Save the outgoing view's scroll position before we leave it.
  if (state.view) scrollPositions[state.view] = viewContainer.scrollTop;
  if (view === 'analysis' && state.view !== 'analysis') state.analysisViewingCycle = null;
  // Record the view we're leaving so "back" can return to it. Back navigations
  // don't push (they're unwinding the stack), and re-navigating to the same
  // view is a no-op for the stack.
  if (!isBack && state.view && state.view !== view) navStack.push(state.view);
  Object.assign(state, params);
  state.view = view;
  navBtns.forEach(b => b.classList.toggle('active', b.dataset.view === view));
  renderView(view);
}

// Go back to the previous view (browser-style). Used by every top-left back
// button and by the swipe-right-from-edge gesture.
function goBack() {
  const prev = navStack.pop() || backFallbackFor(state.view);
  navigate(prev, {}, true);
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
      case 'mortgageFree': await renderMortgageFree(); break;
      case 'helpToBuy':    await renderHelpToBuy(); break;
      case 'investments':  await renderInvestments(); break;
      case 'charity':      await renderCharity(); break;
      case 'pension':      await renderPension(); break;
      case 'bankGilulu':   await renderBankGilulu(); break;
      case 'householdBills': await renderHouseholdBills(); break;
      case 'yearlyTrends': await renderYearlyTrends(); break;
      case 'settings':     await renderSettings(); break;
      case 'import':       renderImport(); break;
      default:             await renderBalance();
    }
  } catch (err) {
    viewContainer.innerHTML = `<div class="empty-state"><div class="empty-icon">⚠️</div><div class="empty-title">Something went wrong</div><div class="empty-text">${err.message}</div></div>`;
    console.error(err);
  }
  // Restore the scroll position for this view (top for a first visit).
  viewContainer.scrollTop = scrollPositions[view] ?? 0;
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

// Blocking progress overlay for long sync operations, so a stalled upload is
// visible on mobile where there is no console to watch.
function showProgressOverlay(title) {
  const el = document.createElement('div');
  el.className = 'sheet-overlay';
  el.innerHTML = `
    <div class="sheet" style="padding:24px 20px 32px">
      <div style="font-size:16px;font-weight:700;margin-bottom:14px;text-align:center">${title}</div>
      <div style="height:8px;background:var(--border);border-radius:4px;overflow:hidden">
        <div id="prog-bar" style="height:100%;width:0%;background:var(--blue);transition:width .2s"></div>
      </div>
      <div id="prog-label" style="font-size:12px;color:var(--text-2);text-align:center;margin-top:10px">Starting…</div>
    </div>`;
  document.body.appendChild(el);
  return {
    update(done, total, label) {
      const pct = total ? Math.round((done / total) * 100) : 0;
      const bar = el.querySelector('#prog-bar');
      const lbl = el.querySelector('#prog-label');
      if (bar) bar.style.width = pct + '%';
      if (lbl) lbl.textContent = `${done.toLocaleString()} / ${total.toLocaleString()} records${label ? ' · ' + label : ''}`;
    },
    close() { el.remove(); },
  };
}

// Per-table result of the last upload, including the raw Firebase error code.
function showUploadReport(report, errorMsg) {
  const el = document.createElement('div');
  el.className = 'sheet-overlay';
  const rows = (report?.tables ?? []).map(t => {
    const ok = !t.error && t.uploaded >= t.total;
    const icon = ok ? '✅' : (t.error ? '❌' : '⚠️');
    return `<div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0">
      <span>${icon} ${t.name}</span>
      <span style="color:var(--text-2)">${t.uploaded}/${t.total}${t.error ? ' · ' + t.error : ''}</span>
    </div>`;
  }).join('');
  el.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header"><span class="screen-title">${errorMsg ? 'Upload incomplete' : 'Upload complete'}</span></div>
      <div class="sheet-body" style="padding:16px">
        ${errorMsg ? `<div style="background:rgba(234,67,53,.1);color:#ea4335;padding:10px;border-radius:8px;font-size:12px;margin-bottom:12px;line-height:1.5">${errorMsg}</div>` : ''}
        <div style="font-size:12px;font-family:monospace;background:var(--bg);padding:12px;border-radius:8px;line-height:1.6">
          ${rows || '<div style="color:var(--text-2)">No tables processed.</div>'}
        </div>
        ${report?.stoppedAt ? `<div style="font-size:11px;color:var(--text-2);margin-top:10px;line-height:1.5">Stopped at <strong>${report.stoppedAt.table}</strong> (record ${report.stoppedAt.offset}). Tapping "Force re-upload" again resumes from here rather than starting over.</div>` : ''}
        <button class="btn btn-primary" id="rep-close" style="width:100%;margin-top:14px">Close</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.onclick = e => { if (e.target === el) el.remove(); };
  el.querySelector('#rep-close').onclick = () => el.remove();
}

// Re-derive distribution children locally after a pull. Distribution rows
// themselves are synced; their daily child transactions are regenerated on each
// device so we never have to write those ~16k rows to Firestore.
async function regenerateAllDistributionChildren() {
  const dists = await db.distributions.toArray();
  const childIds = await db.transactions.where('distributionId').above(0).primaryKeys();
  if (childIds.length) await db.transactions.bulkDelete(childIds);
  for (const dist of dists) {
    if (!dist.id) continue;
    const children = generateDistributionChildren(dist);
    if (children.length) await db.transactions.bulkPut(children);
  }
}

// Non-destructive self-heal: make sure every distribution still has its daily
// child transactions. regenerateAllDistributionChildren() only runs as a signed-
// in post-pull step, so if a sync tombstone or an interrupted rebuild wiped a
// big expense's children, it would silently stop counting against the budget.
// This runs on every app open (online or offline) and only recreates what's
// missing, so nothing is disturbed when everything is already intact.
async function ensureDistributionChildren() {
  const dists = await db.distributions.toArray();
  for (const dist of dists) {
    if (!dist.id || !dist.startDate || !dist.endDate) continue;
    const count = await db.transactions.where('distributionId').equals(dist.id).count();
    if (count === 0) {
      const children = generateDistributionChildren(dist);
      if (children.length) await db.transactions.bulkAdd(children);
    }
  }
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
      wealthBanner = `<div class="wealth-banner" id="wealth-banner-btn">📊 Time for your bi-monthly net wealth update – tap to enter</div>`;
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

  // Animate projection bars (always – gives a nice entrance on every load)
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

async function openEntry(type, existingTxn = null, existingDist = null, forceDistribute = false) {
  if (existingDist) type = existingDist.isIncome ? 'income' : 'expense';
  state.entryType = type;
  state.entryPence = existingDist ? Math.round(Math.abs(existingDist.totalAmount) * 100)
                    : existingTxn ? Math.round(Math.abs(existingTxn.amount) * 100) : 0;
  state.entryCategory = existingDist?.categoryId ?? existingTxn?.categoryId ?? null;
  state.entryDate = existingDist?.startDate ?? existingTxn?.date ?? today();
  state.entryEndDate = existingDist?.endDate ?? state.entryDate;
  state.entryNote = existingDist?.description ?? existingTxn?.note ?? '';
  state.entryEditId = existingTxn?.id ?? null;
  state.entryDistId = existingDist?.id ?? null;
  state.entryDistribute = !!existingDist || forceDistribute;

  const cats = (await db.categories.toArray())
    .filter(c => !c.isArchived && (!!c.isIncome === (type === 'income')))
    .sort((a, b) => a.sortOrder - b.sortOrder);

  const selectedCat = cats.find(c => c.id === state.entryCategory);
  const hasCategory = !!selectedCat;

  let titleText;
  if (existingDist) titleText = `Edit ${type === 'income' ? 'Extra Income' : 'Big Expense'}`;
  else titleText = `${existingTxn ? 'Edit' : 'Add'} ${type === 'income' ? 'Income' : 'Expense'}`;

  const dOn = state.entryDistribute;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.id = 'entry-overlay';

  overlay.innerHTML = `
    <div class="sheet" id="entry-sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <button class="sheet-close" id="entry-close">✕</button>
        <span class="sheet-title">${titleText}</span>
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
            <label id="date-label">${dOn ? 'Start date' : 'Date'}</label>
            <span id="entry-date-display" style="flex:1;font-size:15px;color:var(--text);text-align:right">${fmtDate(state.entryDate)}</span>
            <span style="color:var(--text-2);font-size:18px">›</span>
          </div>
          <div class="entry-field" id="enddate-field" style="cursor:pointer;display:${dOn ? '' : 'none'}">
            <span class="entry-field-icon">🏁</span>
            <label>End date</label>
            <span id="entry-enddate-display" style="flex:1;font-size:15px;color:var(--text);text-align:right">${fmtDate(state.entryEndDate)}</span>
            <span style="color:var(--text-2);font-size:18px">›</span>
          </div>
          <div class="entry-field">
            <span class="entry-field-icon">📝</span>
            <label id="note-label">${dOn ? 'Description' : 'Note'}</label>
            <input type="text" id="entry-note" placeholder="${dOn ? 'e.g. Holiday flights' : 'Optional note'}" value="${state.entryNote.replace(/"/g,'&quot;')}" maxlength="200" autocomplete="off">
          </div>
          <div id="note-suggestions" class="note-suggestions"></div>
          <div class="distribute-mini" id="distribute-row" style="cursor:pointer">
            <span>Distribute over multiple days</span>
            <span class="entry-toggle sm ${dOn ? 'on' : ''}" id="distribute-toggle"></span>
          </div>
          ${existingDist ? `<button class="btn btn-danger" id="entry-delete" style="margin-top:4px">Delete</button>` : ''}
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

  overlay.querySelector('#distribute-row').onclick = () => {
    state.entryDistribute = !state.entryDistribute;
    const on = state.entryDistribute;
    overlay.querySelector('#distribute-toggle').classList.toggle('on', on);
    overlay.querySelector('#date-label').textContent = on ? 'Start date' : 'Date';
    overlay.querySelector('#note-label').textContent = on ? 'Description' : 'Note';
    overlay.querySelector('#entry-note').placeholder = on ? 'e.g. Holiday flights' : 'Optional note';
    overlay.querySelector('#enddate-field').style.display = on ? '' : 'none';
    if (on && state.entryEndDate < state.entryDate) {
      state.entryEndDate = state.entryDate;
      overlay.querySelector('#entry-enddate-display').textContent = fmtDate(state.entryEndDate);
    }
  };

  delegate(overlay, 'click', '.numpad-key:not(.action)', (e, el) => {
    const key = el.dataset.key;
    if (key === '⌫') {
      state.entryPence = Math.floor(state.entryPence / 10);
    } else if (key === '.') {
      // no-op in smart pence mode – digits auto-fill from right
    } else {
      const next = state.entryPence * 10 + parseInt(key);
      if (next <= 9999999) state.entryPence = next;
    }
    el.classList.add('pressed');
    setTimeout(() => el.classList.remove('pressed'), 120);
    updateAmountDisplay(overlay);
  });

  overlay.querySelector('#date-field').onclick = () => {
    const maxD = state.entryDistribute ? '4001-01-01' : today();
    openDatePicker(state.entryDate, maxD, date => {
      state.entryDate = date;
      overlay.querySelector('#entry-date-display').textContent = fmtDate(date);
    });
  };
  overlay.querySelector('#enddate-field').onclick = () => {
    openDatePicker(state.entryEndDate, '4001-01-01', date => {
      state.entryEndDate = date;
      overlay.querySelector('#entry-enddate-display').textContent = fmtDate(date);
    });
  };
  overlay.querySelector('#entry-note').oninput = e => { state.entryNote = e.target.value; };
  overlay.querySelector('#entry-save').onclick = () => saveEntry(overlay);
  overlay.querySelector('#entry-delete')?.addEventListener('click', async () => {
    if (!confirm('Delete this and all its daily entries?')) return;
    // Child transactions are regenerated locally and never uploaded — deleting
    // them locally only (no Firestore tombstones, which would collide with real
    // transaction ids on other devices).
    await db.transactions.where('distributionId').equals(state.entryDistId).delete();
    await db.distributions.delete(state.entryDistId);
    await queueDelete('distributions', state.entryDistId);
    closeEntry(); await refreshAfterEntry(); showToast('Deleted');
  });

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

async function refreshAfterEntry() {
  if (state.view === 'balance') await renderBalance();
  else if (state.view === 'transactions') await renderTransactions();
  else if (state.view === 'distributions') await renderDistributions();
  else if (state.view === 'extraIncomes') await renderExtraIncomes();
}

async function saveEntry(overlay) {
  const amount = state.entryPence / 100;
  if (!amount || amount <= 0) { showToast('Enter an amount'); return; }

  if (state.entryDistribute) {
    // Save as a distribution (big expense / extra income) spread across a range
    const description = (state.entryNote || '').trim();
    if (!description) { showToast('Add a description'); return; }
    if (!state.entryEndDate || state.entryEndDate < state.entryDate) {
      showToast('End date must be after start date'); return;
    }
    const isIncome = state.entryType === 'income';
    let categoryId = state.entryCategory;
    if (!categoryId && !isIncome) categoryId = 28; // Misc
    const distData = {
      description, totalAmount: amount, categoryId,
      startDate: state.entryDate, endDate: state.entryEndDate,
      isIncome, isFinished: state.entryEndDate < today(),
    };
    // Drop old daily children locally only — they're never synced, so writing
    // Firestore delete tombstones would collide with real transaction ids.
    if (state.entryDistId) {
      await db.transactions.where('distributionId').equals(state.entryDistId).delete();
    }
    // Converting a plain transaction into a distribution — remove the original.
    if (state.entryEditId) {
      await db.transactions.delete(state.entryEditId);
      queueDelete('transactions', state.entryEditId).catch(() => {});
    }
    let distId;
    if (state.entryDistId) { await db.distributions.update(state.entryDistId, distData); distId = state.entryDistId; }
    else { distId = await db.distributions.add(distData); }
    await queueWrite('distributions', distId);
    const children = generateDistributionChildren({ ...distData, id: distId });
    await db.transactions.bulkAdd(children);
    // Children are regenerated locally on every device — not queued for upload.
    showToast(state.entryDistId ? 'Updated' : `Created ${children.length} daily entries`);
  } else {
    // Save as a single transaction
    if (!state.entryCategory && state.entryType === 'expense') state.entryCategory = 28;
    // Converting a distribution back into a single transaction — remove it.
    if (state.entryDistId) {
      await db.transactions.where('distributionId').equals(state.entryDistId).delete();
      await db.distributions.delete(state.entryDistId);
      await queueDelete('distributions', state.entryDistId);
    }
    const finalAmount = state.entryType === 'expense' ? -amount : amount;
    const txn = {
      date: state.entryDate, amount: finalAmount, categoryId: state.entryCategory,
      note: (state.entryNote || '').trim(), type: state.entryType, distributionId: null,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), syncStatus: 'pending',
    };
    if (state.entryEditId) {
      await db.transactions.update(state.entryEditId, { ...txn, updatedAt: new Date().toISOString() });
      queueWrite('transactions', state.entryEditId).catch(() => {});
      showToast('Transaction updated');
    } else {
      const newId = await db.transactions.add(txn);
      queueWrite('transactions', newId).catch(() => {});
      showToast('Saved');
    }
  }

  closeEntry();
  await refreshAfterEntry();
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

  // Compute rolling balance (budget left) for each month – the single source of truth
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
    queueDelete('transactions', id).catch(() => {});
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

  const subNav = {
    'Regular income':    () => navigate('recurring', { recurringTab: 'income' }),
    'Extra income':      () => navigate('extraIncomes'),
    'Recurring expenses':() => navigate('recurring', { recurringTab: 'expenses' }),
    'Variable expenses': () => navigate('transactions'),
    'Big Expenses':      () => navigate('distributions'),
  };

  viewContainer.innerHTML = `
    <div class="breakdown-screen">
      <div class="screen-header">
        <button class="icon-btn" onclick="window.app.goBack()">
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
        <div>
          <div class="breakdown-row" id="bdr-income" style="cursor:default">
            <div class="breakdown-row-icon" style="background:#e8f5e9">💰</div>
            <div class="breakdown-row-info"><div class="breakdown-row-label">Income</div></div>
            <div class="breakdown-row-amount text-green">
              ${fmt(Math.abs(bd.totalIncome))}
              <div style="font-size:11px;font-weight:400;color:var(--text-2)">${fmt(Math.abs(bd.regularIncome / cycleLen))}/day</div>
            </div>
          </div>
          ${[{ label: 'Regular income', amount: bd.regularIncome }, { label: 'Extra income', amount: bd.variableIncome }].filter(s => s.amount !== 0).map(s => `
            <div class="breakdown-sub-rows">
              <div class="breakdown-sub-row" data-nav="${s.label}" style="cursor:pointer">
                <span class="breakdown-sub-label">${s.label}</span>
                <span class="breakdown-sub-amount" style="display:flex;align-items:center;gap:6px">${fmt(Math.abs(s.amount))}<span style="color:var(--text-2);font-size:14px">›</span></span>
              </div>
            </div>
          `).join('')}
        </div>
        <div>
          <div class="breakdown-row" style="cursor:default">
            <div class="breakdown-row-icon" style="background:#ffebee">🛒</div>
            <div class="breakdown-row-info"><div class="breakdown-row-label">Expenses</div></div>
            <div class="breakdown-row-amount text-red">
              ${fmt(Math.abs(bd.totalExpenses))}
              <div style="font-size:11px;font-weight:400;color:var(--text-2)">${fmt(Math.abs(bd.recurringExpenses / cycleLen))}/day</div>
            </div>
          </div>
          ${[{ label: 'Recurring expenses', amount: bd.recurringExpenses }, { label: 'Variable expenses', amount: bd.variableExpenses }, { label: 'Big Expenses', amount: bd.distributionExpenses }].filter(s => s.amount !== 0).map(s => `
            <div class="breakdown-sub-rows">
              <div class="breakdown-sub-row" data-nav="${s.label}" style="cursor:pointer">
                <span class="breakdown-sub-label">${s.label}</span>
                <span class="breakdown-sub-amount" style="display:flex;align-items:center;gap:6px">${fmt(Math.abs(s.amount))}<span style="color:var(--text-2);font-size:14px">›</span></span>
              </div>
            </div>
          `).join('')}
        </div>
        <div>
          <div class="breakdown-row" id="bdr-savings" style="cursor:pointer">
            <div class="breakdown-row-icon" style="background:#fffde7">💛</div>
            <div class="breakdown-row-info"><div class="breakdown-row-label">Savings</div></div>
            <div class="breakdown-row-amount" style="display:flex;align-items:center;gap:6px">
              ${fmt(Math.abs(bd.savings))}
              <span style="color:var(--text-2);font-size:14px">›</span>
            </div>
          </div>
        </div>
        <div>
          <div class="breakdown-row" style="cursor:default">
            <div class="breakdown-row-icon" style="background:#e3f2fd">📊</div>
            <div class="breakdown-row-info"><div class="breakdown-row-label">Budget left</div></div>
            <div class="breakdown-row-amount ${bd.budgetLeft >= 0 ? 'text-green' : 'text-red'}">${fmt(Math.abs(bd.budgetLeft))}</div>
          </div>
        </div>
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
  viewContainer.querySelectorAll('[data-nav]').forEach(el => {
    el.onclick = () => { const fn = subNav[el.dataset.nav]; if (fn) fn(); };
  });
  viewContainer.querySelector('#bdr-savings').onclick = () => openSavingsSheet();
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
        <button class="icon-btn" onclick="window.app.goBack()" style="position:absolute;top:52px;left:12px;color:white;opacity:0.9">
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

// ── Household Bills ───────────────────────────────────────────────────────────
async function renderHouseholdBills() {
  if (!state.householdBillsMonth) state.householdBillsMonth = today().slice(0, 7);
  const [ym_y, ym_m] = state.householdBillsMonth.split('-').map(Number);
  const cycleStart = isoDate(new Date(ym_y, ym_m - 1, 1));
  const cycleEnd   = isoDate(new Date(ym_y, ym_m, 0));
  const cycleLen   = diffDays(cycleStart, cycleEnd) + 1;
  const monthLabel = new Date(cycleStart + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const isCurrentMonth = state.householdBillsMonth === today().slice(0, 7);

  const activeFilter = r => r.startDate <= cycleEnd && (r.endDate == null || r.endDate === '4001-01-01' || r.endDate >= cycleStart);
  const allExpenses = (await db.recurringExpenses.toArray()).filter(activeFilter);

  function monthlyAmt(r, cs = cycleStart, ce = cycleEnd, cl = cycleLen) {
    const effStart = r.startDate > cs ? r.startDate : cs;
    const effEnd   = (!r.endDate || r.endDate === '4001-01-01' || r.endDate > ce) ? ce : r.endDate;
    const overlap  = Math.max(0, diffDays(effStart, effEnd) + 1);
    return dailyEquivalent(r.amount ?? 0, r.frequency ?? 'monthly', cl) * overlap;
  }

  allExpenses.sort((a, b) => monthlyAmt(b) - monthlyAmt(a));
  const richOwes = allExpenses.filter(r => r.isShared).reduce((s, r) => s + monthlyAmt(r), 0);

  // History: last 6 months (including current)
  const allRecurring = await db.recurringExpenses.toArray();
  const history = [];
  for (let i = 5; i >= 0; i--) {
    const dt   = new Date(ym_y, ym_m - 1 - i, 1);
    const hS   = isoDate(dt);
    const hE   = isoDate(new Date(dt.getFullYear(), dt.getMonth() + 1, 0));
    const hL   = diffDays(hS, hE) + 1;
    const hLbl = dt.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
    const hAct = r => r.startDate <= hE && (r.endDate == null || r.endDate === '4001-01-01' || r.endDate >= hS);
    const hTotal = allRecurring.filter(r => hAct(r) && r.isShared).reduce((s, r) => s + monthlyAmt(r, hS, hE, hL), 0);
    history.push({ label: hLbl, total: hTotal, isCurrent: i === 0 });
  }

  viewContainer.innerHTML = `
    <div class="recurring-screen">
      <div class="recurring-hero" style="background:linear-gradient(160deg,#1565c0 0%,#1a73e8 100%);position:relative">
        <button class="icon-btn" onclick="window.app.goBack()" style="position:absolute;top:52px;left:12px;color:white;opacity:0.9">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="recurring-hero-icon">🏠</div>
        <div class="recurring-hero-total">Rich owes</div>
        <div class="recurring-hero-amount">${fmt(richOwes)}<span style="font-size:16px;opacity:0.7"> /month</span></div>
        <div class="breakdown-cycle-nav" style="background:rgba(0,0,0,0.15);border-radius:20px;margin:8px auto 0;width:fit-content;padding:2px 4px">
          <button class="cycle-nav-btn" id="hb-prev" style="color:white;opacity:0.9">&lt;</button>
          <span style="color:white;font-size:13px;min-width:130px;text-align:center">${monthLabel}</span>
          <button class="cycle-nav-btn" id="hb-next" style="color:white;opacity:0.9;visibility:${isCurrentMonth ? 'hidden' : 'visible'}">&gt;</button>
        </div>
      </div>

      <div class="recurring-list">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
          <div style="font-size:12px;font-weight:600;color:var(--text-2);letter-spacing:.05em">RECURRING EXPENSES</div>
          <div style="display:flex;gap:6px">
            <button class="btn" id="hb-copy" style="padding:5px 12px;font-size:12px">📋 Copy total</button>
            <button class="btn" id="hb-copy-detail" style="padding:5px 12px;font-size:12px">📋 Copy detailed</button>
          </div>
        </div>
        ${allExpenses.length === 0 ? `<div class="empty-state"><div class="empty-text">No recurring expenses this month</div></div>` : ''}
        ${allExpenses.map(r => {
          const monthly = monthlyAmt(r);
          return `
          <div class="recurring-card" style="align-items:center;gap:10px">
            <label style="display:flex;align-items:center;gap:10px;flex:1;cursor:pointer;min-width:0">
              <input type="checkbox" class="hb-toggle" data-id="${r.id}" ${r.isShared ? 'checked' : ''}
                     style="width:20px;height:20px;flex-shrink:0;accent-color:var(--blue);cursor:pointer">
              <div style="flex:1;min-width:0">
                <div class="recurring-card-name">${r.description}</div>
                <div class="recurring-card-meta" style="color:${r.isShared ? 'var(--blue)' : 'var(--text-2)'}">
                  ${r.isShared ? '✓ Rich pays half' : 'David only'}
                </div>
              </div>
            </label>
            <div style="font-weight:700;font-size:15px;color:${r.isShared ? 'var(--blue)' : 'var(--text-2)'}">
              ${r.isShared ? fmt(monthly) : '–'}
            </div>
          </div>`;
        }).join('')}
        <div style="border-top:1.5px solid var(--border);margin-top:8px;padding-top:10px;display:flex;justify-content:space-between;align-items:center">
          <span style="font-weight:700;font-size:15px">Total Rich owes</span>
          <span style="font-weight:800;font-size:18px;color:var(--blue)">${fmt(richOwes)}</span>
        </div>
      </div>

      <div class="recurring-list" style="margin-top:4px">
        <div style="font-size:12px;font-weight:600;color:var(--text-2);letter-spacing:.05em;margin-bottom:8px">HISTORY</div>
        ${history.map(h => `
          <div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)">
            <span style="color:${h.isCurrent ? 'var(--text)' : 'var(--text-2)'};font-weight:${h.isCurrent ? '600' : '400'}">${h.label}</span>
            <span style="font-weight:${h.isCurrent ? '700' : '400'};color:${h.isCurrent ? 'var(--blue)' : 'var(--text)'}">${fmt(h.total)}</span>
          </div>`).join('')}
      </div>
      <div style="height:80px"></div>
    </div>
  `;

  viewContainer.querySelector('#hb-copy').onclick = () => {
    const text = `${monthLabel} – Rich owes ${fmt(richOwes)} for household bills`;
    navigator.clipboard?.writeText(text).catch(() => {}).finally(() => showToast('Copied!'));
  };
  viewContainer.querySelector('#hb-copy-detail').onclick = () => {
    const lines = allExpenses.filter(r => r.isShared)
      .map(r => `${r.description} - ${fmt(monthlyAmt(r))}`)
      .join('\n');
    const text = `${monthLabel} – Rich owes ${fmt(richOwes)} for household bills\n\n${lines}`;
    navigator.clipboard?.writeText(text).catch(() => {}).finally(() => showToast('Copied!'));
  };
  viewContainer.querySelector('#hb-prev').onclick = () => {
    const [y, m] = state.householdBillsMonth.split('-').map(Number);
    state.householdBillsMonth = isoDate(new Date(y, m - 2, 1)).slice(0, 7);
    renderHouseholdBills();
  };
  const hbNext = viewContainer.querySelector('#hb-next');
  if (hbNext) hbNext.onclick = () => {
    const [y, m] = state.householdBillsMonth.split('-').map(Number);
    const next = isoDate(new Date(y, m, 1)).slice(0, 7);
    if (next <= today().slice(0, 7)) { state.householdBillsMonth = next; renderHouseholdBills(); }
  };
  viewContainer.querySelectorAll('.hb-toggle').forEach(cb => {
    cb.addEventListener('change', async () => {
      await db.recurringExpenses.update(Number(cb.dataset.id), { isShared: cb.checked });
      queueWrite('recurringExpenses', Number(cb.dataset.id)).catch(() => {});
      renderHouseholdBills();
    });
  });
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
      <div style="padding:4px 16px 8px">
        <button class="chip" id="btn-yearly-trends" style="font-size:13px;padding:6px 14px">📅 Yearly trends</button>
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
            : `<span style="font-size:12px;color:var(--text-2)">–</span>`;
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

  // Rolling balance chart – consistent y-axis intervals
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

  // Surplus/loss bar chart – blue positive, orange negative
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

  viewContainer.querySelector('#btn-yearly-trends').addEventListener('click', () => {
    state.yearlyTrendsYear = new Date().getFullYear();
    navigate('yearlyTrends');
  });

  // Category compare toggle
  viewContainer.querySelector('#compare-last').addEventListener('click', () => {
    state.analysisCatCompare = 'lastMonth'; renderAnalysis();
  });
  viewContainer.querySelector('#compare-avg').addEventListener('click', () => {
    state.analysisCatCompare = 'avg12'; renderAnalysis();
  });
}

// ── Yearly Trends ─────────────────────────────────────────────────────────────
async function renderYearlyTrends() {
  const year = state.yearlyTrendsYear ?? new Date().getFullYear();
  const todayStr = today();
  const yearStart = `${year}-01-01`;
  const yearEnd   = `${year}-12-31`;
  const prevYearStart = `${year - 1}-01-01`;
  const prevYearEnd   = `${year - 1}-12-31`;
  const yTick = v => Math.abs(v) >= 1000 ? `£${(v / 1000).toFixed(1)}k` : `£${v.toFixed(0)}`;
  const fmtTip = v => '£' + Math.abs(v).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const cats = await db.categories.toArray();
  const catMap = Object.fromEntries(cats.map(c => [c.id, c]));

  // Fetch both years' transactions in parallel
  const [yearTxns, prevTxns] = await Promise.all([
    db.transactions.where('date').between(yearStart, yearEnd, true, true).toArray(),
    db.transactions.where('date').between(prevYearStart, prevYearEnd, true, true).toArray(),
  ]);

  // ── Month-by-month savings & surplus ──────────────────────────────────────
  const monthlyData = [];
  let cumulativeSaved = 0;

  for (let m = 1; m <= 12; m++) {
    const mStart = isoDate(new Date(year, m - 1, 1));
    const mEnd   = isoDate(new Date(year, m, 0));
    if (mStart > todayStr) break;

    const cutoff = mEnd < todayStr ? mEnd : todayStr;
    const { dailyAllowance, monthlySavings, cycleLen } = await calcDailyAllowance(mStart, mEnd);
    const daysElapsed = mEnd < todayStr ? cycleLen : (diffDays(mStart, todayStr) + 1);

    const mTxns = yearTxns.filter(t => t.date >= mStart && t.date <= cutoff);
    let varExp = 0, varInc = 0;
    for (const t of mTxns) {
      if (t.amount < 0) varExp += Math.abs(t.amount);
      else varInc += t.amount;
    }

    const balance = dailyAllowance * daysElapsed - varExp + varInc;
    const monthSaved = monthlySavings + balance;
    cumulativeSaved += monthSaved;

    const label = new Date(mStart + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short' });
    monthlyData.push({ m, label, balance, monthlySavings, monthSaved, cumulativeSaved });
  }

  // ── Category spending: year vs prev year ──────────────────────────────────
  const isExp = t => t.type === 'expense' || t.type === 'distributed_expense';
  const byCat = {}, prevByCat = {};
  for (const t of yearTxns.filter(isExp)) byCat[t.categoryId] = (byCat[t.categoryId] ?? 0) + Math.abs(t.amount);
  for (const t of prevTxns.filter(isExp)) prevByCat[t.categoryId] = (prevByCat[t.categoryId] ?? 0) + Math.abs(t.amount);
  const catRows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const totalYearSpend = Object.values(byCat).reduce((s, v) => s + v, 0);
  const totalPrevSpend = Object.values(prevByCat).reduce((s, v) => s + v, 0);

  // ── Variable spending by month: current vs prev year ──────────────────────
  const varByMonth = Array.from({ length: 12 }, (_, i) => {
    const ms = `${year}-${String(i + 1).padStart(2, '0')}`;
    const ps = `${year - 1}-${String(i + 1).padStart(2, '0')}`;
    const cur = yearTxns.filter(t => t.date.startsWith(ms) && isExp(t)).reduce((s, t) => s + Math.abs(t.amount), 0);
    const prev = prevTxns.filter(t => t.date.startsWith(ps) && isExp(t)).reduce((s, t) => s + Math.abs(t.amount), 0);
    return { label: new Date(year, i, 1).toLocaleDateString('en-GB', { month: 'short' }), cur, prev };
  });

  // ── Top 5 spends (grouped by note) ───────────────────────────────────────
  // Distributed expenses count as 1 entry (not one per daily child)
  const spendByName = {};
  for (const t of yearTxns.filter(isExp)) {
    const key = (t.note ?? '').trim() || 'Unnamed';
    if (!spendByName[key]) spendByName[key] = { total: 0, count: 0, categoryId: t.categoryId, _distIds: new Set() };
    spendByName[key].total += Math.abs(t.amount);
    if (t.distributionId) {
      if (!spendByName[key]._distIds.has(t.distributionId)) {
        spendByName[key]._distIds.add(t.distributionId);
        spendByName[key].count++;
      }
    } else {
      spendByName[key].count++;
    }
  }
  const top5Spends = Object.entries(spendByName).sort((a, b) => b[1].total - a[1].total).slice(0, 5);

  // ── Top 5 extra incomes (grouped by note) ────────────────────────────────
  // Distributed incomes count as 1 entry (not one per daily child)
  const incomeByName = {};
  for (const t of yearTxns.filter(t => t.type === 'income' || t.type === 'distributed_income')) {
    const key = (t.note ?? '').trim() || 'Unnamed';
    if (!incomeByName[key]) incomeByName[key] = { total: 0, count: 0, _distIds: new Set() };
    incomeByName[key].total += t.amount;
    if (t.distributionId) {
      if (!incomeByName[key]._distIds.has(t.distributionId)) {
        incomeByName[key]._distIds.add(t.distributionId);
        incomeByName[key].count++;
      }
    } else {
      incomeByName[key].count++;
    }
  }
  const top5Incomes = Object.entries(incomeByName).sort((a, b) => b[1].total - a[1].total).slice(0, 5);

  const finalSaved = monthlyData.at(-1)?.cumulativeSaved ?? 0;

  viewContainer.innerHTML = `
    <div class="analysis-screen">
      <div class="screen-header" style="padding-top:52px">
        <button class="icon-btn" id="yt-back">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="screen-title">${year} · Yearly Trends</span>
        <div style="display:flex;gap:0">
          <button class="icon-btn" id="yt-prev">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
          </button>
          <button class="icon-btn" id="yt-next" ${year >= new Date().getFullYear() ? 'style="opacity:.3;pointer-events:none"' : ''}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>
        </div>
      </div>

      <!-- Running savings total -->
      <div class="analysis-section">
        <div class="analysis-section-title">Running savings total – ${year}</div>
        <div style="text-align:center;padding:6px 0 12px">
          <div style="font-size:32px;font-weight:800;color:${finalSaved >= 0 ? '#43a047' : '#e53935'}">${fmt(Math.abs(finalSaved))}</div>
          <div style="font-size:12px;color:var(--text-2)">${finalSaved >= 0 ? 'total saved so far' : 'in deficit so far'}</div>
        </div>
        <div class="chart-wrap"><canvas id="chart-yt-savings"></canvas></div>
      </div>

      <!-- Monthly surplus / loss -->
      <div class="analysis-section">
        <div class="analysis-section-title">Monthly surplus / loss</div>
        <div class="chart-wrap"><canvas id="chart-yt-surplus"></canvas></div>
      </div>

      <!-- Spending by category vs previous year -->
      <div class="analysis-section">
        <div class="analysis-section-title">
          Spending by category
          <span style="float:right;font-size:12px;color:var(--text-2);font-weight:400">${year} vs ${year - 1}</span>
        </div>
        ${catRows.length === 0
          ? '<div class="empty-state" style="padding:12px 0"><div class="empty-text">No spending data yet</div></div>'
          : catRows.map(([cid, total]) => {
              const cat = catMap[cid];
              const prev = prevByCat[cid] ?? 0;
              const diff = total - prev;
              const diffStr = prev > 0
                ? `<span style="font-size:12px;font-weight:600;color:${diff > 0 ? '#e53935' : '#43a047'}">${diff > 0 ? '+' : ''}${fmt(diff)}</span>`
                : `<span style="font-size:12px;color:var(--text-2)">–</span>`;
              return `<div class="cat-bar-row">
                <span class="cat-dot" style="background:${cat?.colour ?? '#ccc'}"></span>
                <span class="cat-bar-label">${cat?.icon ?? ''} ${cat?.name ?? 'Other'}</span>
                <span class="cat-bar-diff">${diffStr}</span>
                <span class="cat-bar-amount">${fmt(total)}</span>
              </div>`;
            }).join('')}
        ${catRows.length > 0 ? `
          <div style="display:flex;justify-content:space-between;margin-top:8px;padding-top:8px;border-top:1px solid var(--border);font-size:13px">
            <span style="font-weight:700">Total ${year}</span>
            <span style="font-weight:700">${fmt(totalYearSpend)}</span>
          </div>
          <div style="text-align:right;font-size:12px;color:var(--text-2);margin-top:2px">${year - 1}: ${fmt(totalPrevSpend)} · diff: <span style="color:${totalYearSpend > totalPrevSpend ? '#e53935' : '#43a047'}">${totalYearSpend > totalPrevSpend ? '+' : ''}${fmt(totalYearSpend - totalPrevSpend)}</span></div>
        ` : ''}
      </div>

      <!-- Variable spending by month: year vs prev year -->
      <div class="analysis-section">
        <div class="analysis-section-title">Variable spending – ${year} vs ${year - 1}</div>
        <div class="chart-wrap"><canvas id="chart-yt-varspend"></canvas></div>
      </div>

      <!-- Top 5 spends -->
      <div class="analysis-section">
        <div class="analysis-section-title">Top spending groups – ${year}</div>
        ${top5Spends.length === 0
          ? '<div class="empty-state" style="padding:12px 0"><div class="empty-text">No spending data</div></div>'
          : top5Spends.map(([name, d], i) => {
              const cat = catMap[d.categoryId];
              return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;${i < top5Spends.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
                <div style="width:36px;height:36px;border-radius:50%;background:${cat?.colour ?? '#ccc'}22;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">${cat?.icon ?? '💸'}</div>
                <div style="flex:1;min-width:0">
                  <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
                  <div style="font-size:12px;color:var(--text-2)">${d.count} transaction${d.count !== 1 ? 's' : ''}</div>
                </div>
                <div style="font-weight:700;color:var(--coral);font-size:15px">${fmt(d.total)}</div>
              </div>`;
            }).join('')}
      </div>

      <!-- Top 5 extra incomes -->
      ${top5Incomes.length > 0 ? `
      <div class="analysis-section" style="margin-bottom:80px">
        <div class="analysis-section-title">Top extra incomes – ${year}</div>
        ${top5Incomes.map(([name, d], i) => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 0;${i < top5Incomes.length - 1 ? 'border-bottom:1px solid var(--border)' : ''}">
            <div style="width:36px;height:36px;border-radius:50%;background:#43a04722;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0">💰</div>
            <div style="flex:1;min-width:0">
              <div style="font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${name}</div>
              <div style="font-size:12px;color:var(--text-2)">${d.count} time${d.count !== 1 ? 's' : ''}</div>
            </div>
            <div style="font-weight:700;color:#43a047;font-size:15px">${fmt(d.total)}</div>
          </div>`).join('')}
      </div>
      ` : '<div style="height:80px"></div>'}
    </div>
  `;

  // Running savings line chart
  new Chart(viewContainer.querySelector('#chart-yt-savings').getContext('2d'), {
    type: 'line',
    data: {
      labels: monthlyData.map(m => m.label),
      datasets: [{
        data: monthlyData.map(m => m.cumulativeSaved),
        borderColor: '#43a047',
        backgroundColor: 'rgba(67,160,71,0.1)',
        borderWidth: 2, fill: true, tension: 0.35, pointRadius: 4, pointBackgroundColor: '#43a047',
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmtTip(ctx.parsed.y) } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 11 }, callback: yTick } },
      },
    },
  });

  // Monthly surplus/loss bar chart
  new Chart(viewContainer.querySelector('#chart-yt-surplus').getContext('2d'), {
    type: 'bar',
    data: {
      labels: monthlyData.map(m => m.label),
      datasets: [{
        data: monthlyData.map(m => m.monthSaved),
        backgroundColor: monthlyData.map(m => m.monthSaved >= 0 ? 'rgba(67,160,71,0.75)' : 'rgba(229,57,53,0.75)'),
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => fmtTip(ctx.parsed.y) } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 11 }, callback: yTick } },
      },
    },
  });

  // Variable spending by month comparison chart
  new Chart(viewContainer.querySelector('#chart-yt-varspend').getContext('2d'), {
    type: 'bar',
    data: {
      labels: varByMonth.map(m => m.label),
      datasets: [
        { label: String(year),     data: varByMonth.map(m => m.cur),  backgroundColor: 'rgba(26,115,232,0.8)',  borderRadius: 3 },
        { label: String(year - 1), data: varByMonth.map(m => m.prev), backgroundColor: 'rgba(26,115,232,0.25)', borderRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: 'top', labels: { font: { size: 11 }, boxWidth: 12, padding: 8 } },
        tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: ${fmtTip(ctx.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 11 }, callback: yTick } },
      },
    },
  });

  viewContainer.querySelector('#yt-back').onclick = () => goBack();
  viewContainer.querySelector('#yt-prev').onclick = () => { state.yearlyTrendsYear = year - 1; renderYearlyTrends(); };
  viewContainer.querySelector('#yt-next')?.addEventListener('click', () => {
    if (year < new Date().getFullYear()) { state.yearlyTrendsYear = year + 1; renderYearlyTrends(); }
  });
}

function makeDistCard(d, catMap) {
  const cat = catMap[d.categoryId];
  // "Finished" is derived from the date, not the stored isFinished flag — that
  // flag is only set at save time, so a distribution that ran out naturally
  // would otherwise keep showing a full progress bar forever.
  const finished = d.endDate < today();
  const progress = Math.min(100, Math.max(0, diffDays(d.startDate, today()) / Math.max(1, diffDays(d.startDate, d.endDate)) * 100));
  return `
    <div class="dist-card" data-dist-id="${d.id}">
      <div class="dist-card-header"><span class="dist-card-name">${d.description}</span><span class="dist-card-amount">${fmt(Math.abs(d.totalAmount))}</span></div>
      <div class="dist-card-meta">${cat?.icon ?? ''} ${cat?.name ?? ''} &bull; ${fmtDate(d.startDate)} - ${fmtDate(d.endDate)}</div>
      ${!finished ? `<div class="dist-progress-wrap"><div class="dist-progress-fill" style="width:${progress}%"></div></div>` : ''}
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
        <button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
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
        <button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
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

// Big expenses / extra incomes now share the same sheet layout as logging a
// normal expense / income, just with the "Distribute over days" toggle already
// flicked on. This is a thin wrapper that routes into that unified editor.
async function openDistEditor(id, isIncomeType = false) {
  const dist = id ? await db.distributions.get(id) : null;
  const isIncomeDist = dist ? !!dist.isIncome : isIncomeType;
  const type = isIncomeDist ? 'income' : 'expense';
  await openEntry(type, null, dist, true);
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
      const pctIncome = monthlyIncome > 0 ? (amount / monthlyIncome * 100).toFixed(1) : '–';
      const pctTakeHome = takeHome > 0 ? (amount / takeHome * 100).toFixed(1) : '–';
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
  const [accounts, allSnapshots, inflationRate, inflationOverridesRaw, allRates] = await Promise.all([
    db.accounts.orderBy('sortOrder').toArray(),
    db.accountSnapshots.toArray(),
    getSetting('inflationRate'),
    getSetting('inflationOverrides'),
    db.accountRates.toArray(),
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
    return v != null ? fmt2(v) : '–';
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
              if (!lastOctNet || d === lastOctDate) return `<td style="${colStyle}">–</td>`;
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
        <button class="icon-btn" onclick="window.app.goBack()">
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
        <div id="nw-reconciliation-panel"></div>
        <div class="settings-card" style="margin:4px 12px 8px">
          <div class="settings-row" style="cursor:pointer" id="nw-edit-past-btn">
            <span class="settings-row-icon">✏️</span>
            <span class="settings-row-label">Edit a past snapshot</span>
            <span class="settings-row-chevron">›</span>
          </div>
          <div class="settings-row" style="cursor:pointer" id="nw-transfers-btn">
            <span class="settings-row-icon">↔</span>
            <span class="settings-row-label">View transfers</span>
            <span class="settings-row-chevron">›</span>
          </div>
          <div class="settings-row" style="cursor:pointer" id="nw-rates-btn">
            <span class="settings-row-icon">📊</span>
            <span class="settings-row-label">Account rates</span>
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
  nwScreen.querySelector('#nw-add-btn').addEventListener('click', () => openNwAddMenu());
  const emptyAdd = nwScreen.querySelector('#nw-empty-add');
  if (emptyAdd) emptyAdd.addEventListener('click', () => openWealthSnapshotEditor(null));

  nwScreen.querySelector('#nw-edit-past-btn')?.addEventListener('click', () => openPastSnapshotPicker(dates));
  nwScreen.querySelector('#nw-transfers-btn')?.addEventListener('click', () => openTransferListSheet());
  nwScreen.querySelector('#nw-rates-btn')?.addEventListener('click', () => openAccountRatesEditor());

  // Rate expiry warning
  const today = new Date();
  const soon = new Date(today); soon.setDate(today.getDate() + 7);
  const soonStr = soon.toISOString().slice(0, 10);
  const todayStr = today.toISOString().slice(0, 10);
  const expiringRates = allRates.filter(r => r.endDate && r.endDate >= todayStr && r.endDate <= soonStr);
  if (expiringRates.length > 0) {
    const accMap = Object.fromEntries(accounts.map(a => [a.id, a.name]));
    const banner = document.createElement('div');
    banner.style.cssText = 'margin:6px 12px;padding:10px 14px;background:#fff3cd;border-radius:8px;font-size:13px;color:#856404;cursor:pointer';
    banner.innerHTML = `⚠️ Rate expiring soon: ${expiringRates.map(r => `${accMap[r.accountId] ?? 'Account'} (${r.endDate})`).join(', ')}`;
    banner.addEventListener('click', () => openAccountRatesEditor());
    nwScreen.querySelector('#nw-reconciliation-panel')?.before(banner);
  }

  // Reconciliation panel with prev/next navigation across snapshot pairs.
  // dates is newest-first; reconIdx=0 means the most recent pair (dates[1]→dates[0]).
  // reconIdx=1 means the next older pair (dates[2]→dates[1]), and so on.
  if (dates.length >= 2) {
    let reconIdx = 0;
    const maxIdx = dates.length - 2; // deepest valid index

    function renderReconPanel() {
      const panel = nwScreen.querySelector('#nw-reconciliation-panel');
      if (!panel) return;
      panel.innerHTML = '<div style="padding:20px 14px;text-align:center;color:var(--text-2);font-size:13px">Loading reconciliation…</div>';
      const endDate   = dates[reconIdx];
      const startDate = dates[reconIdx + 1];
      buildReconciliationHTML(startDate, endDate, snapshotMap, allSnapshots, accounts, reconIdx < maxIdx, reconIdx > 0)
        .then(html => {
          if (!panel.isConnected) return;
          panel.innerHTML = html;
          panel.querySelector('#recon-older')?.addEventListener('click', () => { reconIdx++; renderReconPanel(); });
          panel.querySelector('#recon-newer')?.addEventListener('click', () => { reconIdx--; renderReconPanel(); });
        })
        .catch(e => { panel.innerHTML = ''; console.warn('reconciliation panel failed:', e); });
    }
    renderReconPanel();
  }

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
      const displayVal = val != null ? fmt(Math.abs(val)) + (val < 0 ? ' (neg)' : '') : '–';
      return `<div class="settings-row nw-acc-row" data-acc-id="${a.id}" style="gap:8px;align-items:center;cursor:pointer">
        <div style="flex:1;min-width:0">
          <div style="font-size:14px">${a.name}${isDebt ? ' <span style="font-size:11px;color:var(--text-2)">(debt)</span>' : ''}</div>
        </div>
        <div class="nw-amount-tap" style="font-size:15px;font-weight:600;color:${val != null && val < 0 ? 'var(--coral)' : 'var(--text)'};min-width:100px;text-align:right">${val != null ? (val < 0 ? '-' : '') + fmt(Math.abs(val)) : '–'}</div>
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
          // New account – add to DB and get real ID
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

// ── Net Wealth: reconciliation helpers ────────────────────────────────────────

function reconcileTypeForAccount(acc) {
  switch (acc.type) {
    case 'bank': case 'credit': return 'cash';
    case 'savings': return 'savings';
    case 'investment': case 'pension': return 'investment';
    case 'mortgage': return 'mortgage';
    case 'property': return 'property';
    default: return 'excluded';
  }
}

async function calcReconciliation(startDate, endDate, snapshotMap, allSnapshots, accounts) {
  const days = diffDays(startDate, endDate) + 1;

  function balanceAt(accountId, date) {
    const exact = snapshotMap[date]?.[accountId];
    if (exact != null) return exact;
    const snaps = allSnapshots
      .filter(s => s.accountId === accountId && s.date <= date)
      .sort((a, b) => b.date.localeCompare(a.date));
    return snaps[0]?.balance ?? 0;
  }

  const [allRates, transfers, overpayRows] = await Promise.all([
    db.accountRates.toArray(),
    db.accountTransfers.where('date').between(startDate, endDate, true, true).toArray(),
    db.mortgageOverpayments.where('date').between(startDate, endDate, true, true).toArray(),
  ]);

  // Mortgage overpayments in this period. David's own portion is a transfer
  // (current account → mortgage), so it's wealth-neutral and needs nothing on the
  // expected side. Rich's portion pays down a debt the app counts fully as David's,
  // so it's a genuine wealth gain and IS added to the expected total.
  const overpayMine = overpayRows.reduce((s, o) => s + (Number(o.myAmount) || 0), 0);
  const overpayRich = overpayRows.reduce((s, o) => s + (Number(o.richAmount) || 0), 0);

  // Expected savings = for each complete budget cycle within [startDate, endDate],
  // the planned savings target PLUS whatever daily budget was left over. Both figures
  // come straight from getCycleBreakdown – the same single source of truth the Daily
  // Budget screen uses – so nothing here is hand-entered.
  const savingsByPeriod = [];
  // Use calcRollingBalance(cycleEnd) – the identical call the month picker uses –
  // so "Budget left" here always matches what the user sees on the Daily Budget screen.
  let cursor = startDate;
  while (cursor <= endDate) {
    const cyc = await getCycleForDate(cursor);
    if (cyc.start >= startDate && cyc.end <= endDate) {
      const rb = await calcRollingBalance(cyc.end);
      savingsByPeriod.push({
        label: new Date(cyc.start + 'T12:00:00').toLocaleDateString('en-GB', { month: 'long' }),
        savingsTarget: rb.monthlySavings,
        budgetLeft: rb.balance,
        net: rb.monthlySavings + rb.balance,
      });
    }
    cursor = addDays(cyc.end, 1);
  }
  const totalNewSavings = savingsByPeriod.reduce((s, p) => s + p.net, 0);

  function rateAt(accountId, date) {
    return allRates
      .filter(r => r.accountId === accountId && r.startDate <= date && (!r.endDate || r.endDate >= date))
      .sort((a, b) => b.startDate.localeCompare(a.startDate))[0] ?? null;
  }

  // Savings interest (using opening balance at startDate)
  let savingsInterest = 0;
  const savingsDetails = [];
  for (const acc of accounts) {
    if (reconcileTypeForAccount(acc) !== 'savings') continue;
    const bal = balanceAt(acc.id, startDate);
    if (!bal) continue;
    const rate = rateAt(acc.id, startDate);
    if (!rate) continue;
    const interest = bal * (rate.rate / 100) * (days / 365);
    savingsInterest += interest;
    savingsDetails.push({ name: acc.name, balance: bal, rate: rate.rate, interest });
  }

  // Mortgage interest COST (negative: interest accruing is a wealth drain)
  let mortgageInterestCost = 0;
  let mortgageDetails = null;
  for (const acc of accounts) {
    if (reconcileTypeForAccount(acc) !== 'mortgage') continue;
    const bal = Math.abs(balanceAt(acc.id, startDate));
    if (!bal) continue;
    const rate = rateAt(acc.id, startDate);
    if (!rate) continue;
    const interest = bal * (rate.rate / 100) * (days / 365);
    mortgageInterestCost -= interest; // negative
    mortgageDetails = { name: acc.name, balance: bal, rate: rate.rate, interestCost: interest };
  }

  const accountMap = Object.fromEntries(accounts.map(a => [a.id, a]));

  function groupChange(accs) {
    return accs.reduce((s, a) => s + balanceAt(a.id, endDate) - balanceAt(a.id, startDate), 0);
  }

  const investmentAccs = accounts.filter(a => reconcileTypeForAccount(a) === 'investment');
  // Actual change must match the Net Wealth table exactly: every active account,
  // including holdings (Bank of Gilulu) and loans that reconcileType treats as "excluded".
  const activeAccounts = accounts.filter(a => a.isActive !== false && a.type !== 'holding_archived');
  const actualChange = groupChange(activeAccounts);

  // Investment market returns = actual investment change minus any transfers in/out
  const enrichedTransfers = transfers.map(t => ({ ...t, fromAcc: accountMap[t.fromAccountId], toAcc: accountMap[t.toAccountId] }));
  const investmentDetails = investmentAccs.map(a => {
    const change = balanceAt(a.id, endDate) - balanceAt(a.id, startDate);
    const transferred = enrichedTransfers.reduce((s, t) => {
      if (t.toAccountId === a.id) return s + t.amount;
      if (t.fromAccountId === a.id) return s - t.amount;
      return s;
    }, 0);
    return { id: a.id, name: a.name, change, transferred, marketReturn: change - transferred };
  }).filter(d => d.change !== 0 || d.transferred !== 0);

  const investmentMarketReturn = investmentDetails.reduce((s, d) => s + d.marketReturn, 0);
  const expectedTotal = totalNewSavings + savingsInterest + mortgageInterestCost + investmentMarketReturn + overpayRich;
  const discrepancy = actualChange - expectedTotal;

  return {
    startDate, endDate, days,
    actualChange,
    savingsByPeriod, totalNewSavings,
    savingsInterest, savingsDetails,
    mortgageInterestCost, mortgageDetails,
    investmentMarketReturn, investmentDetails,
    mortgageOverpay: { mine: overpayMine, rich: overpayRich, total: overpayMine + overpayRich, count: overpayRows.length },
    expectedTotal, discrepancy,
    transfers: enrichedTransfers,
  };
}

async function buildReconciliationHTML(startDate, endDate, snapshotMap, allSnapshots, accounts, canOlder = false, canNewer = false) {
  const recon = await calcReconciliation(startDate, endDate, snapshotMap, allSnapshots, accounts);
  const fmtChg = v => `${v >= 0 ? '+' : ''}${fmt(v)}`;
  const clr = v => v >= 0 ? '#43a047' : '#e53935';
  const BD = 'border-bottom:1px solid var(--border);';
  const rowS = 'display:flex;justify-content:space-between;align-items:flex-start;padding:5px 0;';
  const subS = rowS + 'font-size:13px;color:var(--text-2);';
  const hdgS = 'font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2);margin-bottom:4px;';
  const ind = 'padding-left:14px;';
  const pad = 'padding:12px 14px;';
  const lbl = new Date(startDate + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
            + ' – ' + new Date(endDate + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

  const discAbs = Math.abs(recon.discrepancy);
  const discClr = discAbs < 50 ? '#43a047' : (recon.discrepancy < 0 ? '#e53935' : '#ff9800');
  const discNote = discAbs < 50 ? 'Fully accounted for'
    : recon.discrepancy > 0 ? 'More wealth gained than expected – possible unlogged income or timing difference'
    : 'Less wealth gained than expected – possible unlogged spending or timing difference';

  // Expected savings rows (per budget cycle): savings target + budget left
  const ind2 = 'padding-left:28px;';
  const newSavingsRows = recon.savingsByPeriod.map(p => `
    <div style="${subS}${ind}font-weight:600;color:var(--text)"><span>${p.label}</span><span style="color:${clr(p.net)}">${fmtChg(p.net)}</span></div>
    <div style="${subS}${ind2}"><span>Savings target</span><span style="color:${clr(p.savingsTarget)}">${fmtChg(p.savingsTarget)}</span></div>
    <div style="${subS}${ind2}"><span>Budget left</span><span style="color:${clr(p.budgetLeft)}">${fmtChg(p.budgetLeft)}</span></div>
  `).join('');

  // Savings interest rows
  const savingsRows = recon.savingsDetails.map(d =>
    `<div style="${subS}${ind}"><span>${d.name} (${d.rate}% AER on ${fmt(d.balance)})</span><span style="color:#43a047">+${fmt(d.interest)}</span></div>`
  ).join('');

  // Mortgage interest cost row (negative)
  const mortgageRow = recon.mortgageDetails ? `
    <div style="${subS}${ind}">
      <span>${recon.mortgageDetails.rate}% AER on ${fmt(recon.mortgageDetails.balance)} · ${recon.days}d</span>
      <span style="color:#e53935">–${fmt(recon.mortgageDetails.interestCost)}</span>
    </div>` : '';

  // Investment rows — summary only (no per-transfer detail rows)
  const invRows = recon.investmentDetails.map(d => `
    <div style="${subS}${ind}">
      <div>
        <div>${d.name}</div>
        ${d.transferred ? `<div style="font-size:11px;color:var(--text-2)">incl. ${fmtChg(d.transferred)} transfers in/out</div>` : ''}
      </div>
      <span style="color:${clr(d.marketReturn)}">${fmtChg(d.marketReturn)}</span>
    </div>`).join('');

  return `
    <div class="settings-card" style="margin:8px 12px">

      <div style="${pad}${BD}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
          <button id="recon-older" style="background:none;border:none;font-size:18px;padding:0 4px;cursor:pointer;color:${canOlder ? 'var(--text)' : 'var(--border)'};pointer-events:${canOlder ? 'auto' : 'none'}">‹</button>
          <div style="${hdgS}margin-bottom:0">Reconciliation · ${lbl}</div>
          <button id="recon-newer" style="background:none;border:none;font-size:18px;padding:0 4px;cursor:pointer;color:${canNewer ? 'var(--text)' : 'var(--border)'};pointer-events:${canNewer ? 'auto' : 'none'}">›</button>
        </div>
        <div style="${rowS}font-weight:700;font-size:15px">
          <span>Actual net wealth change</span>
          <span style="color:${clr(recon.actualChange)}">${fmtChg(recon.actualChange)}</span>
        </div>
      </div>

      <div style="${pad}${BD}">
        <div style="${hdgS}">Expected savings</div>
        ${newSavingsRows}
        ${recon.savingsByPeriod.length > 1 ? `
        <div style="${rowS}padding-top:4px;border-top:1px solid var(--border);font-weight:600;font-size:13px">
          <span>Subtotal</span><span style="color:${clr(recon.totalNewSavings)}">${fmtChg(recon.totalNewSavings)}</span>
        </div>` : ''}
      </div>

      ${recon.savingsInterest > 0.01 ? `
      <div style="${pad}${BD}">
        <div style="${hdgS}">Savings interest (estimated)</div>
        ${savingsRows}
        ${recon.savingsDetails.length > 1 ? `
        <div style="${rowS}padding-top:4px;border-top:1px solid var(--border);font-weight:600;font-size:13px">
          <span>Subtotal</span><span style="color:#43a047">+${fmt(recon.savingsInterest)}</span>
        </div>` : ''}
      </div>` : ''}

      ${recon.mortgageDetails ? `
      <div style="${pad}${BD}">
        <div style="${hdgS}">Mortgage interest (cost)</div>
        ${mortgageRow}
      </div>` : ''}

      ${recon.mortgageOverpay && recon.mortgageOverpay.count > 0 ? `
      <div style="${pad}${BD}">
        <div style="${hdgS}">Mortgage overpayments</div>
        <div style="${subS}${ind}"><span>Your contribution (transfer, neutral)</span><span style="color:var(--text-2)">${fmt(recon.mortgageOverpay.mine)}</span></div>
        <div style="${subS}${ind}"><span>Rich's contribution (counted)</span><span style="color:#43a047">+${fmt(recon.mortgageOverpay.rich)}</span></div>
      </div>` : ''}

      ${recon.investmentDetails.length > 0 ? `
      <div style="${pad}${BD}">
        <div style="${hdgS}">Market investments</div>
        ${invRows}
        <div style="${rowS}padding-top:4px;border-top:1px solid var(--border);font-weight:600;font-size:13px">
          <span>Total market return</span><span style="color:${clr(recon.investmentMarketReturn)}">${fmtChg(recon.investmentMarketReturn)}</span>
        </div>
      </div>` : ''}

      <div style="${pad}${BD}">
        <div style="${rowS}font-weight:700;font-size:15px">
          <span>Total expected</span>
          <span style="color:${clr(recon.expectedTotal)}">${fmtChg(recon.expectedTotal)}</span>
        </div>
      </div>

      <div style="${pad}">
        <div style="${rowS}font-weight:700;font-size:15px">
          <span>Discrepancy</span>
          <span style="color:${discClr}">${fmtChg(recon.discrepancy)}</span>
        </div>
        <div style="font-size:12px;color:${discClr};margin-top:3px">${discNote}</div>
      </div>

    </div>`;
}

function openNwAddMenu() {
  const menu = document.createElement('div');
  menu.className = 'sheet-overlay';
  menu.innerHTML = `
    <div class="sheet" style="max-height:260px">
      <div class="sheet-handle"></div>
      <div class="sheet-body" style="padding:20px 16px;display:flex;flex-direction:column;gap:10px">
        <button class="btn btn-primary btn-full" id="nw-menu-snap" style="font-size:16px;padding:16px">📸 Record snapshot</button>
        <button class="btn btn-full" id="nw-menu-transfer" style="font-size:16px;padding:16px">↔ Log transfer</button>
      </div>
    </div>`;
  document.body.appendChild(menu);
  menu.onclick = e => { if (e.target === menu) menu.remove(); };
  menu.querySelector('#nw-menu-snap').onclick = () => { menu.remove(); openWealthSnapshotEditor(null); };
  menu.querySelector('#nw-menu-transfer').onclick = () => { menu.remove(); openTransferEditor(null); };
}

async function openTransferEditor(existing) {
  const accounts = (await db.accounts.orderBy('sortOrder').toArray())
    .filter(a => a.isActive !== false && a.type !== 'holding' && a.type !== 'holding_archived');

  let fromId      = existing?.fromAccountId ?? accounts[0]?.id;
  let toId        = existing?.toAccountId   ?? accounts[1]?.id;
  let tDate       = existing?.date          ?? today();
  let amount      = existing?.amount        ?? 0;
  let note        = existing?.note          ?? '';
  let isRecurring = existing?.isRecurring   ?? false;
  let frequency   = existing?.frequency     ?? 'monthly';

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  function build() {
    const opts = accounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title">${existing ? 'Edit' : 'Log'} Transfer</span>
          <button class="sheet-close" id="tf-close">✕</button>
        </div>
        <div class="sheet-body" style="padding:16px">
          <div class="form-group">
            <label class="form-label">From account</label>
            <select class="form-input" id="tf-from">${opts}</select>
          </div>
          <div class="form-group">
            <label class="form-label">To account</label>
            <select class="form-input" id="tf-to">${opts}</select>
          </div>
          <div class="form-group">
            <label class="form-label">Date</label>
            <input class="form-input" type="date" id="tf-date" value="${tDate}" max="${today()}">
          </div>
          <div class="form-group" style="cursor:pointer" id="tf-amount-row">
            <label class="form-label">Amount</label>
            <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
              <span id="tf-amount-disp" style="font-size:16px;font-weight:600;color:var(--text)">${amount > 0 ? fmt(amount) : 'Tap to enter'}</span>
              <span style="color:var(--text-2)">›</span>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Note (optional)</label>
            <input class="form-input" type="text" id="tf-note" value="${note}" placeholder="e.g. Monthly Flex Saver deposit" maxlength="200">
          </div>
          <div class="form-group" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0">
            <label style="font-size:14px;font-weight:500">Recurring transfer</label>
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
              <input type="checkbox" id="tf-recurring" ${isRecurring ? 'checked' : ''} style="width:18px;height:18px">
            </label>
          </div>
          <div class="form-group" id="tf-freq-group" style="display:${isRecurring ? 'block' : 'none'}">
            <label class="form-label">Frequency</label>
            <select class="form-input" id="tf-frequency">
              <option value="weekly" ${frequency === 'weekly' ? 'selected' : ''}>Weekly</option>
              <option value="monthly" ${frequency === 'monthly' ? 'selected' : ''}>Monthly</option>
              <option value="quarterly" ${frequency === 'quarterly' ? 'selected' : ''}>Quarterly</option>
              <option value="annually" ${frequency === 'annually' ? 'selected' : ''}>Annually</option>
            </select>
          </div>
          ${existing ? `<button class="btn btn-danger btn-full" id="tf-del" style="margin-bottom:8px">Delete transfer</button>` : ''}
          <button class="btn btn-primary btn-full" id="tf-save">Save</button>
        </div>
      </div>`;

    overlay.querySelector('#tf-close').onclick = () => overlay.remove();
    overlay.querySelector('#tf-from').value = fromId;
    overlay.querySelector('#tf-to').value   = toId;
    overlay.querySelector('#tf-from').onchange = e => { fromId = Number(e.target.value); };
    overlay.querySelector('#tf-to').onchange   = e => { toId   = Number(e.target.value); };
    overlay.querySelector('#tf-date').onchange  = e => { tDate  = e.target.value; };
    overlay.querySelector('#tf-note').oninput   = e => { note   = e.target.value; };
    overlay.querySelector('#tf-recurring').onchange = e => {
      isRecurring = e.target.checked;
      overlay.querySelector('#tf-freq-group').style.display = isRecurring ? 'block' : 'none';
    };
    overlay.querySelector('#tf-frequency').onchange = e => { frequency = e.target.value; };

    overlay.querySelector('#tf-amount-row').onclick = () => {
      openAmountPad('Transfer amount', amount, val => {
        amount = val;
        overlay.querySelector('#tf-amount-disp').textContent = amount > 0 ? fmt(amount) : 'Tap to enter';
      }, { noNegative: true });
    };

    overlay.querySelector('#tf-save').onclick = async () => {
      if (!amount || amount <= 0) { showToast('Enter an amount'); return; }
      if (fromId === toId) { showToast('From and To must be different accounts'); return; }
      const rec = { fromAccountId: fromId, toAccountId: toId, date: tDate, amount, note: note.trim(), isRecurring, frequency: isRecurring ? frequency : undefined };
      if (existing) {
        await db.accountTransfers.update(existing.id, rec);
        queueWrite('accountTransfers', existing.id).catch(() => {});
      } else {
        const id = await db.accountTransfers.add(rec);
        queueWrite('accountTransfers', id).catch(() => {});
      }
      overlay.remove();
      showToast(existing ? 'Transfer updated' : 'Transfer logged');
      renderNetWealth();
    };

    overlay.querySelector('#tf-del')?.addEventListener('click', async () => {
      await db.accountTransfers.delete(existing.id);
      queueDelete('accountTransfers', existing.id).catch(() => {});
      overlay.remove();
      showToast('Transfer deleted');
      renderNetWealth();
    });
  }
  build();
}

async function openTransferListSheet() {
  const [accounts, transfers] = await Promise.all([
    db.accounts.toArray(),
    db.accountTransfers.toArray(),
  ]);
  const accMap = Object.fromEntries(accounts.map(a => [a.id, a.name]));
  const sorted = [...transfers].sort((a, b) => b.date.localeCompare(a.date));

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  overlay.innerHTML = `
    <div class="sheet" style="max-height:88vh">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">Transfers</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="icon-btn" id="tl-add" title="Log transfer">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          </button>
          <button class="sheet-close" id="tl-close">✕</button>
        </div>
      </div>
      <div class="sheet-body" style="padding:8px 0;overflow-y:auto;max-height:calc(88vh - 60px)">
        ${sorted.length === 0 ? `<div class="empty-state"><div class="empty-text">No transfers logged yet.</div></div>` : ''}
        ${sorted.map(t => `
          <div class="settings-row tl-row" data-id="${t.id}" style="cursor:pointer">
            <div style="flex:1;min-width:0">
              <div style="font-size:14px">${accMap[t.fromAccountId] ?? '?'} → ${accMap[t.toAccountId] ?? '?'}</div>
              <div style="font-size:12px;color:var(--text-2)">${fmtDate(t.date)}${t.isRecurring ? ' · 🔁 ' + t.frequency : ''}${t.note ? ' · ' + t.note : ''}</div>
            </div>
            <span style="font-weight:700;font-size:15px;margin-left:8px">${fmt(t.amount)}</span>
            <span class="settings-row-chevron">›</span>
          </div>`).join('')}
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector('#tl-close').onclick = () => overlay.remove();
  overlay.querySelector('#tl-add').onclick = () => { overlay.remove(); openTransferEditor(null); };
  overlay.querySelectorAll('.tl-row').forEach(row => {
    row.addEventListener('click', () => {
      const t = transfers.find(x => x.id === Number(row.dataset.id));
      if (t) { overlay.remove(); openTransferEditor(t); }
    });
  });
}

// ── Financial goals: mortgage-free tracker ────────────────────────────────────

// Pure monthly amortisation from `principal` at `annualRate`% with a fixed total
// monthly payment (standard + overpayment). Returns the interest paid over the
// life, the number of months to clear, and the balance after each month.
function amortiseMortgage(principal, annualRate, standardMonthly, monthlyOver) {
  const mRate = annualRate / 12 / 100;
  const totalMonthly = standardMonthly + monthlyOver;
  let bal = principal;
  let totalInterest = 0;
  let months = 0;
  const series = [principal];
  const maxMonths = 1200;
  while (bal > 0.005 && months < maxMonths) {
    const interest = bal * mRate;
    let principalPaid = totalMonthly - interest;
    if (principalPaid <= 0) { months = Infinity; break; } // payment never covers interest
    totalInterest += interest;
    principalPaid = Math.min(principalPaid, bal);
    bal = Math.max(0, bal - principalPaid);
    months++;
    series.push(bal);
  }
  return { totalInterest, months, series };
}

async function computeMortgageProjection() {
  const [accounts, snaps, rates, overpayments, myOverRaw, richOverRaw] = await Promise.all([
    db.accounts.toArray(),
    db.accountSnapshots.toArray(),
    db.accountRates.toArray(),
    db.mortgageOverpayments.toArray(),
    getSetting('mortgageMyOverpayment'),
    getSetting('mortgageRichOverpayment'),
  ]);
  const mortgage = accounts.find(a => a.type === 'mortgage' && a.isActive !== false)
                ?? accounts.find(a => a.type === 'mortgage');
  if (!mortgage) return null;

  const t = today();
  const mRates = rates.filter(r => r.accountId === mortgage.id);
  const rate = mRates
    .filter(r => r.startDate <= t && (!r.endDate || r.endDate >= t))
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0]
    ?? mRates.sort((a, b) => b.startDate.localeCompare(a.startDate))[0];
  const annualRate = rate?.rate ?? 3.91;
  const standardMonthly = rate?.monthlyPayment ?? 1073.17;

  // Anchor to the most recent mortgage snapshot (stored negative → principal is abs).
  const mSnaps = snaps.filter(s => s.accountId === mortgage.id).sort((a, b) => a.date.localeCompare(b.date));
  const anchor = mSnaps[mSnaps.length - 1];
  const anchorPrincipal = anchor ? Math.abs(anchor.balance ?? 0) : 182556.18;
  const anchorDate = anchor ? anchor.date : t;

  // Overpayments logged AFTER the anchor snapshot further reduce today's balance;
  // ones before the anchor are already reflected in that snapshot reading.
  const sortedOver = [...overpayments].sort((a, b) => a.date.localeCompare(b.date));
  const overAfterAnchor = sortedOver
    .filter(o => o.date > anchorDate)
    .reduce((s, o) => s + (Number(o.myAmount) || 0) + (Number(o.richAmount) || 0), 0);
  const currentPrincipal = Math.max(0, anchorPrincipal - overAfterAnchor);

  const myOver = Number(myOverRaw ?? 1000) || 0;
  const richOver = Number(richOverRaw ?? 1000) || 0;
  const assumedOver = myOver + richOver;

  const withOver = amortiseMortgage(currentPrincipal, annualRate, standardMonthly, assumedOver);
  const withoutOver = amortiseMortgage(currentPrincipal, annualRate, standardMonthly, 0);
  const interestSaved = withoutOver.totalInterest - withOver.totalInterest;

  const now = new Date();
  const curKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let clearDate = null, clearLabel = null;
  const monthsToClear = withOver.months;
  if (isFinite(monthsToClear)) {
    const c = new Date(now.getFullYear(), now.getMonth() + monthsToClear, 1);
    clearDate = isoDate(c);
    clearLabel = c.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
  }

  const totalMine = sortedOver.reduce((s, o) => s + (Number(o.myAmount) || 0), 0);
  const totalRich = sortedOver.reduce((s, o) => s + (Number(o.richAmount) || 0), 0);
  const totalOverpaid = totalMine + totalRich;

  // Actual interest saved = interest that would have accrued at the mortgage rate
  // on each overpayment from the day it was made until the projected clear date.
  // Approximated as: sum of (overpayment × rate × months_remaining / 12).
  let actualInterestSaved = 0;
  if (isFinite(monthsToClear)) {
    const mRate = annualRate / 100 / 12;
    for (const o of sortedOver) {
      const oTotal = (Number(o.myAmount) || 0) + (Number(o.richAmount) || 0);
      if (!oTotal) continue;
      const oDate2 = new Date(o.date + 'T12:00:00');
      const mRemaining = Math.max(0, (now.getFullYear() - oDate2.getFullYear()) * 12
        + (now.getMonth() - oDate2.getMonth()) + monthsToClear);
      // Simple interest approximation over remaining term
      actualInterestSaved += oTotal * mRate * mRemaining;
    }
  }

  return {
    mortgage, annualRate, standardMonthly, myOver, richOver, assumedOver,
    anchorPrincipal, anchorDate, currentPrincipal,
    withOver, withoutOver, interestSaved,
    clearDate, clearLabel, monthsToClear,
    overpayments: sortedOver, totalMine, totalRich, totalOverpaid, actualInterestSaved, mSnaps, now, curKey,
  };
}

function drawMortgageChart(canvas, p) {
  if (!canvas || typeof Chart === 'undefined') return;
  const now = p.now;
  const curKey = p.curKey;
  const HIST_START = '2021-06'; // David took sole ownership Jun 2021

  const maxLen = Math.max(p.withOver.series.length, p.withoutOver.series.length);
  const cappedLen = Math.min(maxLen, 240);
  const futureKeys = [];
  let y = now.getFullYear(), m = now.getMonth() + 1;
  for (let i = 0; i < cappedLen; i++) { futureKeys.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } }

  // Only include actual snapshots from Jun 2021 onwards
  const histPairs = p.mSnaps
    .map(s => ({ key: s.date.slice(0, 7), bal: Math.abs(s.balance ?? 0) }))
    .filter(x => x.key >= HIST_START && x.key < curKey);

  // Build a dense month-by-month label list from HIST_START to end of projection
  const allKeys = new Set([...histPairs.map(x => x.key), ...futureKeys]);
  const minKey = HIST_START;
  const maxKey = futureKeys[futureKeys.length - 1] ?? curKey;
  const labels = [];
  let ky = +HIST_START.slice(0, 4), km = +HIST_START.slice(5, 7);
  const [endY, endM] = maxKey.split('-').map(Number);
  while (ky < endY || (ky === endY && km <= endM)) {
    labels.push(`${ky}-${String(km).padStart(2, '0')}`);
    km++; if (km > 12) { km = 1; ky++; }
  }

  const idx = Object.fromEntries(labels.map((k, i) => [k, i]));

  const withData = labels.map(() => null);
  const withoutData = labels.map(() => null);
  const actualData = labels.map(() => null);
  p.withOver.series.slice(0, cappedLen).forEach((v, i) => { const k = futureKeys[i]; if (idx[k] != null) withData[idx[k]] = v; });
  p.withoutOver.series.slice(0, cappedLen).forEach((v, i) => { const k = futureKeys[i]; if (idx[k] != null) withoutData[idx[k]] = v; });
  histPairs.forEach(x => { if (idx[x.key] != null) actualData[idx[x.key]] = x.bal; });
  if (idx[curKey] != null) actualData[idx[curKey]] = p.currentPrincipal;

  const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dispLabels = labels.map(k => {
    const [yy, mm] = k.split('-');
    // Show label at Jan of each year and at the very first month
    return (mm === '01' || k === HIST_START) ? `${MON[+mm]} ${yy.slice(2)}` : '';
  });

  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: dispLabels,
      datasets: [
        { label: 'With overpayment', data: withData, borderColor: '#43a047', backgroundColor: 'rgba(67,160,71,0.08)', borderWidth: 2, fill: true, tension: 0.2, pointRadius: 0, spanGaps: true },
        { label: 'Standard only', data: withoutData, borderColor: '#e53935', borderDash: [5, 4], borderWidth: 1.5, fill: false, tension: 0.2, pointRadius: 0, spanGaps: true },
        { label: 'Actual', data: actualData, borderColor: '#ff9800', backgroundColor: '#ff9800', borderWidth: 0, showLine: false, pointRadius: 3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'top', labels: { font: { size: 10 }, boxWidth: 10, padding: 8 } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 90, minRotation: 90, font: { size: 9 }, autoSkip: false } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 10 }, callback: v => Math.abs(v) >= 1000 ? `£${(v / 1000).toFixed(0)}k` : `£${v.toFixed(0)}` } },
      },
    },
  });
}

async function renderMortgageFree() {
  const p = await computeMortgageProjection();

  if (!p) {
    viewContainer.innerHTML = `
      <div class="settings-screen">
        <div class="screen-header">
          <button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
          <span class="screen-title">Mortgage free</span>
          <div style="width:34px"></div>
        </div>
        <div class="empty-state"><div class="empty-icon">🏡</div><div class="empty-text">No mortgage account found.</div></div>
      </div>`;
    return;
  }

  const row = (label, value, id) => `
    <div class="settings-row"${id ? ` id="${id}" style="cursor:pointer"` : ''}>
      <span class="settings-row-label">${label}</span>
      <span style="margin-left:auto;font-weight:600">${value}</span>
      ${id ? '<span class="settings-row-chevron">›</span>' : ''}
    </div>`;
  const oList = p.overpayments.slice().reverse().map(o => `
    <div class="settings-row mf-op-row" data-id="${o.id}" style="cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px">${fmt((Number(o.myAmount) || 0) + (Number(o.richAmount) || 0))}</div>
        <div style="font-size:12px;color:var(--text-2)">${fmtDate(o.date)} · you ${fmt(Number(o.myAmount) || 0)} · Rich ${fmt(Number(o.richAmount) || 0)}${o.note ? ' · ' + o.note : ''}</div>
      </div>
      <span class="settings-row-chevron">›</span>
    </div>`).join('');

  viewContainer.innerHTML = `
    <div class="settings-screen">
      <div class="screen-header">
        <button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
        <span class="screen-title">Mortgage free</span>
        <div style="width:34px"></div>
      </div>
      <div style="text-align:center;padding:16px 16px 6px">
        <div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Estimated balance remaining</div>
        <div style="font-size:32px;font-weight:800">${fmt(p.currentPrincipal)}</div>
        ${p.clearLabel
          ? `<div style="font-size:13px;color:#43a047;margin-top:2px">Projected mortgage-free ${p.clearLabel} · ${p.monthsToClear} months</div>`
          : `<div style="font-size:13px;color:#e53935;margin-top:2px">Payments don't currently cover the interest</div>`}
      </div>
      <div class="chart-wrap" style="height:210px;margin:4px 12px"><canvas id="mf-chart"></canvas></div>
      <div style="padding:10px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Projected savings</div>
      <div class="settings-card" style="margin:4px 12px">
        ${row('Interest rate', p.annualRate + '%')}
        ${row('Standard payment', fmt(p.standardMonthly) + '/mo')}
        ${row('Your monthly overpayment', fmt(p.myOver) + '/mo', 'mf-my-over')}
        ${row("Rich's monthly overpayment", fmt(p.richOver) + '/mo', 'mf-rich-over')}
        ${row('Projected interest saved', fmt(p.interestSaved))}
      </div>
      <div style="padding:12px 12px 8px">
        <button class="btn btn-primary btn-full" id="mf-log">＋ Log overpayment</button>
      </div>
      <div style="padding:10px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Logged overpayments</div>
      ${p.overpayments.length > 0 ? `
      <div class="settings-card" style="margin:4px 12px 0">
        <div class="settings-row">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">Total overpaid to date</div>
            <div style="font-size:12px;color:var(--text-2)">Your ${fmt(p.totalMine)} + Rich's ${fmt(p.totalRich)}${p.actualInterestSaved > 1 ? ` · est. ${fmt(p.actualInterestSaved)} interest saved` : ''}</div>
          </div>
          <span style="font-weight:700;font-size:15px">${fmt(p.totalOverpaid)}</span>
        </div>
      </div>` : ''}
      ${p.overpayments.length === 0
        ? `<div style="padding:8px 16px;color:var(--text-2);font-size:13px">None yet. Log your first overpayment above.</div>`
        : `<div class="settings-card" style="margin:4px 12px">${oList}</div>`}
      <div style="padding-bottom:80px"></div>
    </div>`;

  const reRender = () => renderMortgageFree();
  viewContainer.querySelector('#mf-log').onclick = () => openMortgageOverpaymentEditor(null, reRender, p);
  viewContainer.querySelector('#mf-my-over').onclick = () => openAmountPad('Your monthly overpayment', p.myOver, v => setSetting('mortgageMyOverpayment', Math.max(0, v)).then(() => { queueWrite('settings', 'mortgageMyOverpayment').catch(() => {}); reRender(); }), { noNegative: true });
  viewContainer.querySelector('#mf-rich-over').onclick = () => openAmountPad("Rich's monthly overpayment", p.richOver, v => setSetting('mortgageRichOverpayment', Math.max(0, v)).then(() => { queueWrite('settings', 'mortgageRichOverpayment').catch(() => {}); reRender(); }), { noNegative: true });
  viewContainer.querySelectorAll('.mf-op-row').forEach(r => r.onclick = () => {
    const o = p.overpayments.find(x => x.id === Number(r.dataset.id));
    if (o) openMortgageOverpaymentEditor(o, reRender, p);
  });

  drawMortgageChart(viewContainer.querySelector('#mf-chart'), p);
}

async function openMortgageOverpaymentEditor(existing, onSaved, proj) {
  const accounts = await db.accounts.toArray();
  const mortgage = accounts.find(a => a.type === 'mortgage');
  const fromAcc = accounts.filter(a => a.type === 'bank' && a.isActive !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0]
               ?? accounts.find(a => a.id === 1);

  let oDate = existing?.date ?? today();
  let myAmount = existing?.myAmount ?? (proj?.myOver ?? 1000);
  let richAmount = existing?.richAmount ?? (proj?.richOver ?? 1000);
  let note = existing?.note ?? '';

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${existing ? 'Edit' : 'Log'} overpayment</span>
        <button class="sheet-close" id="mo-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group" style="cursor:pointer" id="mo-date-row">
          <label class="form-label">Date</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="mo-date-disp">${fmtDate(oDate)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="mo-my-row">
          <label class="form-label">Your contribution</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="mo-my-disp" style="font-size:16px;font-weight:600">${fmt(myAmount)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="mo-rich-row">
          <label class="form-label">Rich's contribution</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="mo-rich-disp" style="font-size:16px;font-weight:600">${fmt(richAmount)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div style="background:var(--bg);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:var(--text-2)">
          Total off mortgage: <b id="mo-total" style="color:var(--text)">${fmt(myAmount + richAmount)}</b><br>
          Your ${fmt(myAmount)} is recorded as a transfer from ${fromAcc?.name ?? 'your current account'} → ${mortgage?.name ?? 'Mortgage'}.
        </div>
        <div class="form-group">
          <label class="form-label">Note (optional)</label>
          <input class="form-input" type="text" id="mo-note" value="${note}" placeholder="e.g. March overpayment" maxlength="200">
        </div>
        ${existing ? `<button class="btn btn-danger btn-full" id="mo-del" style="margin-bottom:8px">Delete</button>` : ''}
        <button class="btn btn-primary btn-full" id="mo-save">Save</button>
      </div>
    </div>`;

  const updTotal = () => { overlay.querySelector('#mo-total').textContent = fmt((myAmount || 0) + (richAmount || 0)); };
  overlay.querySelector('#mo-close').onclick = () => overlay.remove();
  overlay.querySelector('#mo-date-row').onclick = () => openDatePicker(oDate, today(), d => { oDate = d; overlay.querySelector('#mo-date-disp').textContent = fmtDate(d); });
  overlay.querySelector('#mo-note').oninput = e => { note = e.target.value; };
  overlay.querySelector('#mo-my-row').onclick = () => openAmountPad('Your contribution', myAmount, v => { myAmount = Math.max(0, v); overlay.querySelector('#mo-my-disp').textContent = fmt(myAmount); updTotal(); }, { noNegative: true });
  overlay.querySelector('#mo-rich-row').onclick = () => openAmountPad("Rich's contribution", richAmount, v => { richAmount = Math.max(0, v); overlay.querySelector('#mo-rich-disp').textContent = fmt(richAmount); updTotal(); }, { noNegative: true });

  overlay.querySelector('#mo-save').onclick = async () => {
    if ((myAmount || 0) + (richAmount || 0) <= 0) { showToast('Enter an amount'); return; }
    const rec = { date: oDate, myAmount: myAmount || 0, richAmount: richAmount || 0, note: note.trim() };

    // Keep the linked "my portion" transfer (current account → mortgage) in sync.
    let transferId = existing?.transferId;
    if ((myAmount || 0) > 0 && fromAcc && mortgage) {
      const tf = { fromAccountId: fromAcc.id, toAccountId: mortgage.id, date: oDate, amount: myAmount, note: 'Mortgage overpayment', isRecurring: false };
      if (transferId) { await db.accountTransfers.update(transferId, tf); queueWrite('accountTransfers', transferId).catch(() => {}); }
      else { transferId = await db.accountTransfers.add(tf); queueWrite('accountTransfers', transferId).catch(() => {}); }
    } else if (transferId) {
      await db.accountTransfers.delete(transferId); queueDelete('accountTransfers', transferId).catch(() => {}); transferId = null;
    }
    rec.transferId = transferId ?? null;

    if (existing) {
      await db.mortgageOverpayments.update(existing.id, rec);
      queueWrite('mortgageOverpayments', existing.id).catch(() => {});
    } else {
      const id = await db.mortgageOverpayments.add(rec);
      queueWrite('mortgageOverpayments', id).catch(() => {});
    }
    overlay.remove();
    showToast(existing ? 'Overpayment updated' : 'Overpayment logged');
    onSaved?.();
  };

  overlay.querySelector('#mo-del')?.addEventListener('click', async () => {
    if (existing.transferId) { await db.accountTransfers.delete(existing.transferId); queueDelete('accountTransfers', existing.transferId).catch(() => {}); }
    await db.mortgageOverpayments.delete(existing.id);
    queueDelete('mortgageOverpayments', existing.id).catch(() => {});
    overlay.remove();
    showToast('Overpayment deleted');
    onSaved?.();
  });
}

// ── Financial goals: Help to Buy equity buy-back ──────────────────────────────
// The equity loan is a % of the property still owned by Help to Buy. Interest is
// charged on that equity value. Buying back a tranche reduces the % owned and so
// reduces the ongoing interest. Property value / rate are user-editable settings
// (we don't hardcode personal figures); the "% remaining" is decremented as
// buy-backs are logged.

async function computeHelpToBuyProjection() {
  const [payments, propValRaw, eqPctRaw, rateRaw, lastPurchaseRaw, trancheRaw] = await Promise.all([
    db.helpToBuyPayments.toArray(),
    getSetting('h2bPropertyValue'),
    getSetting('h2bEquityPercent'),
    getSetting('h2bInterestRate'),
    getSetting('h2bLastPurchaseDate'),
    getSetting('h2bTranchePercent'),
  ]);

  const propertyValue = Number(propValRaw) || 0;
  const equityPercent = eqPctRaw != null ? Number(eqPctRaw) : 20;
  const rate = rateRaw != null ? Number(rateRaw) : 1.75;
  const tranchePercent = trancheRaw != null ? Number(trancheRaw) : 10;
  const lastPurchaseDate = lastPurchaseRaw ?? '2026-02-26';

  const sorted = [...payments].sort((a, b) => a.date.localeCompare(b.date));
  const equityLoanValue = propertyValue * equityPercent / 100;
  const monthlyInterest = equityLoanValue * (rate / 100) / 12;
  const annualInterest = equityLoanValue * (rate / 100);
  const trancheCost = propertyValue * tranchePercent / 100;

  // Interest saved to date: for each logged buy-back, the monthly interest it
  // removed × months elapsed since it was made (approximated at current rate/value).
  const now = new Date();
  let interestSavedToDate = 0;
  for (const pmt of sorted) {
    const pctBought = Number(pmt.percentBought) || 0;
    if (!pctBought || !propertyValue) continue;
    const monthlyReduction = propertyValue * (pctBought / 100) * (rate / 100) / 12;
    const d = new Date(pmt.date + 'T12:00:00');
    const monthsElapsed = Math.max(0, (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()));
    interestSavedToDate += monthlyReduction * monthsElapsed;
  }

  const totalBoughtBack = sorted.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const totalPctBought = sorted.reduce((s, p) => s + (Number(p.percentBought) || 0), 0);

  // Cumulative interest saved over time: each buy-back permanently lowers the
  // monthly interest, so we walk month-by-month from the first buy-back to now,
  // accumulating the running monthly saving.
  const interestSavedSeries = [];
  if (propertyValue > 0 && sorted.length) {
    const pctByMonth = {};
    for (const pmt of sorted) {
      const mk = pmt.date.slice(0, 7);
      pctByMonth[mk] = (pctByMonth[mk] || 0) + (Number(pmt.percentBought) || 0);
    }
    const first = sorted[0].date.slice(0, 7);
    let y = +first.slice(0, 4), m = +first.slice(5, 7);
    const curY = now.getFullYear(), curM = now.getMonth() + 1;
    let cumPct = 0, cumSaved = 0;
    while (y < curY || (y === curY && m <= curM)) {
      const mk = `${y}-${String(m).padStart(2, '0')}`;
      cumPct += pctByMonth[mk] || 0;
      cumSaved += propertyValue * (cumPct / 100) * (rate / 100) / 12;
      interestSavedSeries.push({ month: mk, saved: cumSaved });
      m++; if (m > 12) { m = 1; y++; }
    }
  }

  return {
    propertyValue, equityPercent, rate, tranchePercent, lastPurchaseDate,
    equityLoanValue, monthlyInterest, annualInterest, trancheCost,
    payments: sorted, interestSavedToDate, totalBoughtBack, totalPctBought,
    interestSavedSeries, configured: propertyValue > 0,
  };
}

function drawHelpToBuyChart(canvas, series) {
  if (!canvas || typeof Chart === 'undefined' || series.length < 2) return;
  const MON = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const n = series.length;
  // Pick a sensible label step: every month up to 12, quarterly up to 36, half-yearly up to 72, yearly beyond
  const step = n <= 12 ? 1 : n <= 36 ? 3 : n <= 72 ? 6 : 12;
  const labels = series.map((pt, i) => {
    const [yy, mm] = pt.month.split('-');
    if (i === 0 || i === n - 1 || +mm % step === 1 % step) return `${MON[+mm]} ${yy.slice(2)}`;
    return '';
  });
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Interest saved', data: series.map(pt => pt.saved), borderColor: '#43a047', backgroundColor: 'rgba(67,160,71,0.12)', borderWidth: 2.5, fill: true, tension: 0.3, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 90, minRotation: 90, font: { size: 9 }, autoSkip: false } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 10 }, callback: v => Math.abs(v) >= 1000 ? `£${(v / 1000).toFixed(1)}k` : `£${v.toFixed(0)}` } },
      },
    },
  });
}

async function renderHelpToBuy() {
  const p = await computeHelpToBuyProjection();
  const back = `<button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>`;

  const row = (label, value, id) => `
    <div class="settings-row"${id ? ` id="${id}" style="cursor:pointer"` : ''}>
      <span class="settings-row-label">${label}</span>
      <span style="margin-left:auto;font-weight:600">${value}</span>
      ${id ? '<span class="settings-row-chevron">›</span>' : ''}
    </div>`;
  const pList = p.payments.slice().reverse().map(pm => `
    <div class="settings-row htb-op-row" data-id="${pm.id}" style="cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px">${fmt(Number(pm.amount) || 0)}${pm.percentBought ? ` · ${pm.percentBought}%` : ''}</div>
        <div style="font-size:12px;color:var(--text-2)">${fmtDate(pm.date)}${pm.note ? ' · ' + pm.note : ''}</div>
      </div>
      <span class="settings-row-chevron">›</span>
    </div>`).join('');

  viewContainer.innerHTML = `
    <div class="settings-screen">
      <div class="screen-header">${back}<span class="screen-title">Help to Buy</span><div style="width:34px"></div></div>

      <div style="text-align:center;padding:16px 16px 6px">
        <div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Equity still owned by Help to Buy</div>
        <div style="font-size:32px;font-weight:800">${p.equityPercent}%${p.configured ? ` · ${fmt(p.equityLoanValue)}` : ''}</div>
        ${p.configured
          ? `<div style="font-size:13px;color:#e53935;margin-top:2px">Costs ${fmt(p.monthlyInterest)}/mo · ${fmt(p.annualInterest)}/yr in interest</div>`
          : `<div style="font-size:13px;color:var(--text-2);margin-top:4px">Set your property value below to calculate interest</div>`}
      </div>

      <div style="padding:10px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Details ${p.configured ? '' : '· tap to set'}</div>
      <div class="settings-card" style="margin:4px 12px">
        ${row('Property value', p.propertyValue ? fmt(p.propertyValue) : 'Tap to set', 'htb-propval')}
        ${row('Equity % remaining', p.equityPercent + '%', 'htb-eqpct')}
        ${row('Interest rate', p.rate + '%', 'htb-rate')}
        ${row('Buy-back tranche size', p.tranchePercent + '%' + (p.configured ? ` · ${fmt(p.trancheCost)}` : ''), 'htb-tranche')}
      </div>

      ${p.configured ? `
      <div style="padding:0 16px;font-size:12px;color:var(--text-2);line-height:1.5;margin:4px 0 2px">
        Completing the buy-back would save <b style="color:#43a047">${fmt(p.annualInterest)}/yr</b> in interest.
      </div>` : ''}

      ${p.interestSavedSeries.length > 1 ? `
      <div style="padding:12px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Interest saved over time</div>
      <div class="chart-wrap" style="height:190px;margin:4px 12px"><canvas id="htb-chart"></canvas></div>` : ''}

      <div style="padding:12px 12px 8px">
        <button class="btn btn-primary btn-full" id="htb-log">＋ Log equity buy-back</button>
      </div>

      <div style="padding:10px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Buy-backs logged</div>
      ${p.payments.length > 0 ? `
      <div class="settings-card" style="margin:4px 12px 0">
        <div class="settings-row">
          <div style="flex:1">
            <div style="font-size:13px;font-weight:600">Bought back to date</div>
            <div style="font-size:12px;color:var(--text-2)">${p.totalPctBought}% of property${p.interestSavedToDate > 1 ? ` · est. ${fmt(p.interestSavedToDate)} interest saved` : ''}</div>
          </div>
          <span style="font-weight:700;font-size:15px">${fmt(p.totalBoughtBack)}</span>
        </div>
      </div>` : ''}
      ${p.payments.length === 0
        ? `<div style="padding:8px 16px;color:var(--text-2);font-size:13px">None yet. Log your first buy-back above.</div>`
        : `<div class="settings-card" style="margin:4px 12px">${pList}</div>`}
      <div style="padding-bottom:80px"></div>
    </div>`;

  const reRender = () => renderHelpToBuy();
  const editSetting = (title, key, cur, opts, after) => openAmountPad(title, cur, v => {
    setSetting(key, Math.max(0, v)).then(() => { queueWrite('settings', key).catch(() => {}); after ? after(v) : reRender(); });
  }, opts);

  viewContainer.querySelector('#htb-propval').onclick = () => editSetting('Property value', 'h2bPropertyValue', p.propertyValue, { noNegative: true });
  viewContainer.querySelector('#htb-eqpct').onclick = () => editSetting('Equity % remaining', 'h2bEquityPercent', p.equityPercent, { prefix: '', suffix: '%', noNegative: true, decimals: 1 });
  viewContainer.querySelector('#htb-rate').onclick = () => editSetting('Interest rate', 'h2bInterestRate', p.rate, { prefix: '', suffix: '%', noNegative: true, decimals: 2 });
  viewContainer.querySelector('#htb-tranche').onclick = () => editSetting('Buy-back tranche size', 'h2bTranchePercent', p.tranchePercent, { prefix: '', suffix: '%', noNegative: true, decimals: 0 });
  viewContainer.querySelector('#htb-log').onclick = () => openHelpToBuyPaymentEditor(null, reRender, p);
  viewContainer.querySelectorAll('.htb-op-row').forEach(r => r.onclick = () => {
    const pm = p.payments.find(x => x.id === Number(r.dataset.id));
    if (pm) openHelpToBuyPaymentEditor(pm, reRender, p);
  });
  drawHelpToBuyChart(viewContainer.querySelector('#htb-chart'), p.interestSavedSeries);
}

async function openHelpToBuyPaymentEditor(existing, onSaved, proj) {
  const accounts = await db.accounts.toArray();
  const property = accounts.find(a => a.type === 'property');
  const fromAcc = accounts.filter(a => a.type === 'bank' && a.isActive !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0]
               ?? accounts.find(a => a.id === 1);

  let oDate = existing?.date ?? today();
  let amount = existing?.amount ?? (proj?.trancheCost ?? 0);
  let percentBought = existing?.percentBought ?? (proj?.tranchePercent ?? 10);
  let note = existing?.note ?? '';

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${existing ? 'Edit' : 'Log'} buy-back</span>
        <button class="sheet-close" id="hb-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group" style="cursor:pointer" id="hb-date-row">
          <label class="form-label">Date</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="hb-date-disp">${fmtDate(oDate)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="hb-amount-row">
          <label class="form-label">Amount paid</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="hb-amount-disp" style="font-size:16px;font-weight:600">${amount > 0 ? fmt(amount) : 'Tap to enter'}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="hb-pct-row">
          <label class="form-label">% of property bought back</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="hb-pct-disp" style="font-size:16px;font-weight:600">${percentBought}%</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div style="background:var(--bg);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:var(--text-2)">
          Recorded as a transfer from ${fromAcc?.name ?? 'your current account'} → ${property?.name ?? 'Property'} (equity you now own), and your Help to Buy equity % is reduced by ${percentBought}%.
        </div>
        <div class="form-group">
          <label class="form-label">Note (optional)</label>
          <input class="form-input" type="text" id="hb-note" value="${note}" placeholder="e.g. Second 10% tranche" maxlength="200">
        </div>
        ${existing ? `<button class="btn btn-danger btn-full" id="hb-del" style="margin-bottom:8px">Delete</button>` : ''}
        <button class="btn btn-primary btn-full" id="hb-save">Save</button>
      </div>
    </div>`;

  overlay.querySelector('#hb-close').onclick = () => overlay.remove();
  overlay.querySelector('#hb-date-row').onclick = () => openDatePicker(oDate, today(), d => { oDate = d; overlay.querySelector('#hb-date-disp').textContent = fmtDate(d); });
  overlay.querySelector('#hb-note').oninput = e => { note = e.target.value; };
  overlay.querySelector('#hb-amount-row').onclick = () => openAmountPad('Amount paid', amount, v => { amount = Math.max(0, v); overlay.querySelector('#hb-amount-disp').textContent = amount > 0 ? fmt(amount) : 'Tap to enter'; }, { noNegative: true });
  overlay.querySelector('#hb-pct-row').onclick = () => openAmountPad('% of property bought back', percentBought, v => { percentBought = Math.max(0, v); overlay.querySelector('#hb-pct-disp').textContent = percentBought + '%'; }, { prefix: '', suffix: '%', noNegative: true, decimals: 1 });

  overlay.querySelector('#hb-save').onclick = async () => {
    if ((amount || 0) <= 0) { showToast('Enter an amount'); return; }
    const rec = { date: oDate, amount: amount || 0, percentBought: percentBought || 0, note: note.trim() };

    // Keep the linked transfer (current account → property equity) in sync.
    let transferId = existing?.transferId;
    if ((amount || 0) > 0 && fromAcc && property) {
      const tf = { fromAccountId: fromAcc.id, toAccountId: property.id, date: oDate, amount, note: 'Help to Buy buy-back', isRecurring: false };
      if (transferId) { await db.accountTransfers.update(transferId, tf); queueWrite('accountTransfers', transferId).catch(() => {}); }
      else { transferId = await db.accountTransfers.add(tf); queueWrite('accountTransfers', transferId).catch(() => {}); }
    } else if (transferId) {
      await db.accountTransfers.delete(transferId); queueDelete('accountTransfers', transferId).catch(() => {}); transferId = null;
    }
    rec.transferId = transferId ?? null;

    // Adjust the stored "equity % remaining" by the net change in % bought.
    const prevPct = Number(existing?.percentBought) || 0;
    const deltaPct = (percentBought || 0) - prevPct;
    if (deltaPct !== 0) {
      const curEq = Number(await getSetting('h2bEquityPercent') ?? proj?.equityPercent ?? 20);
      await setSetting('h2bEquityPercent', Math.max(0, curEq - deltaPct));
      queueWrite('settings', 'h2bEquityPercent').catch(() => {});
    }

    if (existing) {
      await db.helpToBuyPayments.update(existing.id, rec);
      queueWrite('helpToBuyPayments', existing.id).catch(() => {});
    } else {
      const id = await db.helpToBuyPayments.add(rec);
      queueWrite('helpToBuyPayments', id).catch(() => {});
    }
    overlay.remove();
    showToast(existing ? 'Buy-back updated' : 'Buy-back logged');
    onSaved?.();
  };

  overlay.querySelector('#hb-del')?.addEventListener('click', async () => {
    if (existing.transferId) { await db.accountTransfers.delete(existing.transferId); queueDelete('accountTransfers', existing.transferId).catch(() => {}); }
    // Give the bought-back % back to the equity-remaining figure.
    const restorePct = Number(existing.percentBought) || 0;
    if (restorePct) {
      const curEq = Number(await getSetting('h2bEquityPercent') ?? 0);
      await setSetting('h2bEquityPercent', curEq + restorePct);
      queueWrite('settings', 'h2bEquityPercent').catch(() => {});
    }
    await db.helpToBuyPayments.delete(existing.id);
    queueDelete('helpToBuyPayments', existing.id).catch(() => {});
    overlay.remove();
    showToast('Buy-back deleted');
    onSaved?.();
  });
}

// ── Financial goals: investments (ISAs) ───────────────────────────────────────
// Tracks cash + stocks ISAs: current value, interest/growth rate, this-year
// contributions (from the contribution log) and total value over time. Logging a
// contribution also records a transfer (current account → ISA) so it's treated
// as a transfer in the net-wealth reconciliation, exactly like mortgage/H2B.

async function computeInvestmentsSummary() {
  const [accounts, snaps, rates, contributions] = await Promise.all([
    db.accounts.orderBy('sortOrder').toArray(),
    db.accountSnapshots.toArray(),
    db.accountRates.toArray(),
    db.investmentContributions.toArray(),
  ]);
  const invAccounts = accounts.filter(a => a.isActive !== false && ['savings', 'investment'].includes(a.type));
  const invIds = new Set(invAccounts.map(a => a.id));

  // Latest snapshot value per account
  const snapMap = {}; // { date: { accId: bal } }
  for (const s of snaps) {
    if (!snapMap[s.date]) snapMap[s.date] = {};
    snapMap[s.date][s.accountId] = s.balance ?? 0;
  }
  const dates = Object.keys(snapMap).sort();
  const latestDate = dates[dates.length - 1];

  const t = today();
  const rateAt = accId => rates
    .filter(r => r.accountId === accId && r.startDate <= t && (!r.endDate || r.endDate >= t))
    .sort((a, b) => b.startDate.localeCompare(a.startDate))[0];

  const thisYear = t.slice(0, 4);
  const perAccount = invAccounts.map(a => {
    const bal = latestDate ? (snapMap[latestDate]?.[a.id] ?? 0) : 0;
    const rate = rateAt(a.id)?.rate ?? null;
    const annualInterest = rate != null ? bal * (rate / 100) : null;
    const contribThisYear = contributions
      .filter(c => c.accountId === a.id && (c.date || '').slice(0, 4) === thisYear)
      .reduce((s, c) => s + (Number(c.amount) || 0), 0);
    return { id: a.id, name: a.name, type: a.type, balance: bal, rate, annualInterest, contribThisYear };
  });

  const totalValue = perAccount.reduce((s, a) => s + a.balance, 0);
  const totalAnnualInterest = perAccount.reduce((s, a) => s + (a.annualInterest || 0), 0);
  const totalContribThisYear = perAccount.reduce((s, a) => s + a.contribThisYear, 0);

  // Total invested over time, split into cash vs stocks (for the stacked chart)
  const series = dates.map(d => {
    let cash = 0, stocks = 0;
    for (const a of invAccounts) {
      const v = snapMap[d]?.[a.id] ?? 0;
      if (a.type === 'savings') cash += v; else stocks += v;
    }
    return { date: d, cash, stocks, total: cash + stocks };
  }).filter(pt => pt.total !== 0);

  // Monthly cost of living target (from recurring expenses), for the FIRE goal line
  return {
    invAccounts, perAccount, totalValue, totalAnnualInterest, totalContribThisYear,
    thisYear, series, latestDate,
    contributions: [...contributions].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
  };
}

function drawInvestmentsChart(canvas, series) {
  if (!canvas || typeof Chart === 'undefined' || series.length < 2) return;
  const labels = series.map(pt => new Date(pt.date + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }));
  if (canvas._chart) canvas._chart.destroy();
  // Stacked areas: stocks on the bottom, cash on top — combined height = total,
  // and the split shows the cash-vs-stocks proportion over time.
  canvas._chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Stocks', data: series.map(pt => pt.stocks), borderColor: '#1a73e8', backgroundColor: 'rgba(26,115,232,0.55)', borderWidth: 1.5, fill: true, tension: 0.3, pointRadius: 0 },
        { label: 'Cash', data: series.map(pt => pt.cash), borderColor: '#43a047', backgroundColor: 'rgba(67,160,71,0.55)', borderWidth: 1.5, fill: true, tension: 0.3, pointRadius: 0 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: true, position: 'top', labels: { font: { size: 11 }, boxWidth: 12, padding: 10 } } },
      scales: {
        x: { grid: { display: false }, ticks: { maxRotation: 90, minRotation: 90, font: { size: 9 } } },
        y: { stacked: true, grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 10 }, callback: v => Math.abs(v) >= 1000 ? `£${(v / 1000).toFixed(0)}k` : `£${v.toFixed(0)}` } },
      },
    },
  });
}

async function renderInvestments() {
  const s = await computeInvestmentsSummary();
  const back = `<button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>`;

  const cashAccs = s.perAccount.filter(a => a.type === 'savings');
  const stockAccs = s.perAccount.filter(a => a.type === 'investment');
  const acctRow = a => `
    <div class="settings-row">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px">${a.name}</div>
        <div style="font-size:12px;color:var(--text-2)">${a.rate != null ? `${a.rate}% · ${fmt(a.annualInterest)}/yr` : 'no rate set'}${a.contribThisYear ? ` · +${fmt(a.contribThisYear)} in ${s.thisYear}` : ''}</div>
      </div>
      <span style="font-weight:600;font-size:15px">${fmt(a.balance)}</span>
    </div>`;
  const cList = s.contributions.slice(0, 20).map(c => {
    const acc = s.perAccount.find(a => a.id === c.accountId);
    return `
    <div class="settings-row inv-c-row" data-id="${c.id}" style="cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px">${acc?.name ?? 'ISA'} · ${fmt(Number(c.amount) || 0)}</div>
        <div style="font-size:12px;color:var(--text-2)">${fmtDate(c.date)}${c.note ? ' · ' + c.note : ''}</div>
      </div>
      <span class="settings-row-chevron">›</span>
    </div>`;
  }).join('');

  viewContainer.innerHTML = `
    <div class="settings-screen">
      <div class="screen-header">${back}<span class="screen-title">Investments</span><div style="width:34px"></div></div>

      <div style="text-align:center;padding:16px 16px 6px">
        <div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Total invested</div>
        <div style="font-size:32px;font-weight:800">${fmt(s.totalValue)}</div>
        <div style="font-size:13px;color:#43a047;margin-top:2px">Generating ~${fmt(s.totalAnnualInterest)}/yr · ${fmt(s.totalAnnualInterest / 12)}/mo</div>
      </div>

      ${s.series.length > 1 ? `<div class="chart-wrap" style="height:210px;margin:4px 12px"><canvas id="inv-chart"></canvas></div>` : ''}

      <div style="padding:10px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Goal</div>
      <div style="padding:0 16px;font-size:12px;color:var(--text-2);line-height:1.5">
        The long-term aim is for investment interest to cover your monthly living costs. You're currently generating <b style="color:var(--text)">${fmt(s.totalAnnualInterest / 12)}/mo</b> in interest.
      </div>

      ${cashAccs.length ? `
      <div style="padding:12px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Cash ISAs</div>
      <div class="settings-card" style="margin:4px 12px">${cashAccs.map(acctRow).join('')}</div>` : ''}

      ${stockAccs.length ? `
      <div style="padding:12px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Stocks ISAs</div>
      <div class="settings-card" style="margin:4px 12px">${stockAccs.map(acctRow).join('')}</div>` : ''}

      <div style="padding:14px 12px 8px">
        <button class="btn btn-primary btn-full" id="inv-log">＋ Log contribution</button>
      </div>

      <div style="padding:10px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Contributions${s.totalContribThisYear ? ` · ${fmt(s.totalContribThisYear)} in ${s.thisYear}` : ''}</div>
      ${s.contributions.length === 0
        ? `<div style="padding:8px 16px;color:var(--text-2);font-size:13px">None logged yet.</div>`
        : `<div class="settings-card" style="margin:4px 12px">${cList}</div>`}
      <div style="padding-bottom:80px"></div>
    </div>`;

  const reRender = () => renderInvestments();
  viewContainer.querySelector('#inv-log').onclick = () => openInvestmentContributionEditor(null, reRender, s);
  viewContainer.querySelectorAll('.inv-c-row').forEach(r => r.onclick = () => {
    const c = s.contributions.find(x => x.id === Number(r.dataset.id));
    if (c) openInvestmentContributionEditor(c, reRender, s);
  });
  drawInvestmentsChart(viewContainer.querySelector('#inv-chart'), s.series);
}

async function openInvestmentContributionEditor(existing, onSaved, summary) {
  const accounts = await db.accounts.toArray();
  const invAccounts = accounts.filter(a => a.isActive !== false && ['savings', 'investment'].includes(a.type)).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
  const fromAcc = accounts.filter(a => a.type === 'bank' && a.isActive !== false).sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))[0]
               ?? accounts.find(a => a.id === 1);

  let accountId = existing?.accountId ?? invAccounts[0]?.id;
  let oDate = existing?.date ?? today();
  let amount = existing?.amount ?? 0;
  let note = existing?.note ?? '';

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  const opts = invAccounts.map(a => `<option value="${a.id}">${a.name}</option>`).join('');
  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${existing ? 'Edit' : 'Log'} contribution</span>
        <button class="sheet-close" id="ic-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group">
          <label class="form-label">Into account</label>
          <select class="form-input" id="ic-acc">${opts}</select>
        </div>
        <div class="form-group" style="cursor:pointer" id="ic-date-row">
          <label class="form-label">Date</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="ic-date-disp">${fmtDate(oDate)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="ic-amount-row">
          <label class="form-label">Amount</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="ic-amount-disp" style="font-size:16px;font-weight:600">${amount > 0 ? fmt(amount) : 'Tap to enter'}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div style="background:var(--bg);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:13px;color:var(--text-2)">
          Recorded as a transfer from ${fromAcc?.name ?? 'your current account'} → the chosen ISA, so it counts as a transfer in your net-wealth reconciliation.
        </div>
        <div class="form-group">
          <label class="form-label">Note (optional)</label>
          <input class="form-input" type="text" id="ic-note" value="${note}" placeholder="e.g. Monthly ISA top-up" maxlength="200">
        </div>
        ${existing ? `<button class="btn btn-danger btn-full" id="ic-del" style="margin-bottom:8px">Delete</button>` : ''}
        <button class="btn btn-primary btn-full" id="ic-save">Save</button>
      </div>
    </div>`;

  overlay.querySelector('#ic-close').onclick = () => overlay.remove();
  overlay.querySelector('#ic-acc').value = accountId;
  overlay.querySelector('#ic-acc').onchange = e => { accountId = Number(e.target.value); };
  overlay.querySelector('#ic-date-row').onclick = () => openDatePicker(oDate, today(), d => { oDate = d; overlay.querySelector('#ic-date-disp').textContent = fmtDate(d); });
  overlay.querySelector('#ic-note').oninput = e => { note = e.target.value; };
  overlay.querySelector('#ic-amount-row').onclick = () => openAmountPad('Contribution amount', amount, v => { amount = Math.max(0, v); overlay.querySelector('#ic-amount-disp').textContent = amount > 0 ? fmt(amount) : 'Tap to enter'; }, { noNegative: true });

  overlay.querySelector('#ic-save').onclick = async () => {
    if ((amount || 0) <= 0) { showToast('Enter an amount'); return; }
    if (!accountId) { showToast('Pick an account'); return; }
    const rec = { accountId, date: oDate, amount: amount || 0, note: note.trim() };

    let transferId = existing?.transferId;
    if (fromAcc) {
      const tf = { fromAccountId: fromAcc.id, toAccountId: accountId, date: oDate, amount, note: 'ISA contribution', isRecurring: false };
      if (transferId) { await db.accountTransfers.update(transferId, tf); queueWrite('accountTransfers', transferId).catch(() => {}); }
      else { transferId = await db.accountTransfers.add(tf); queueWrite('accountTransfers', transferId).catch(() => {}); }
    }
    rec.transferId = transferId ?? null;

    if (existing) {
      await db.investmentContributions.update(existing.id, rec);
      queueWrite('investmentContributions', existing.id).catch(() => {});
    } else {
      const id = await db.investmentContributions.add(rec);
      queueWrite('investmentContributions', id).catch(() => {});
    }
    overlay.remove();
    showToast(existing ? 'Contribution updated' : 'Contribution logged');
    onSaved?.();
  };

  overlay.querySelector('#ic-del')?.addEventListener('click', async () => {
    if (existing.transferId) { await db.accountTransfers.delete(existing.transferId); queueDelete('accountTransfers', existing.transferId).catch(() => {}); }
    await db.investmentContributions.delete(existing.id);
    queueDelete('investmentContributions', existing.id).catch(() => {});
    overlay.remove();
    showToast('Contribution deleted');
    onSaved?.();
  });
}

// ── Financial goals: charity donations ────────────────────────────────────────
// Each row is a monthly commitment to a charity active over [startDate, endDate]
// (endDate null = ongoing). Total donated to a charity = amount × months active,
// summed across its commitments.

// Whole months a commitment has been active (inclusive of both start & end month).
function charityMonthsActive(startDate, endDate) {
  if (!startDate) return 0;
  const end = endDate || today();
  const [sy, sm] = startDate.split('-').map(Number);
  const [ey, em] = end.split('-').map(Number);
  return Math.max(0, (ey - sy) * 12 + (em - sm) + 1);
}

const CHARITY_SEED = [
  { charity: 'Labour Party',              amount: 15, startDate: '2023-06-01', endDate: '2026-02-28' },
  { charity: 'Pump Aid',                  amount: 15, startDate: '2023-06-01', endDate: '2026-02-28' },
  { charity: 'Stonewall',                 amount: 15, startDate: '2023-06-01', endDate: '2026-02-28' },
  { charity: 'Fitzrovia Youth in Action', amount: 15, startDate: '2023-06-01', endDate: '2026-02-28' },
  { charity: 'Give Directly',             amount: 15, startDate: '2023-06-01', endDate: '2026-02-28' },
  { charity: 'Big Issue Foundation',      amount: 15, startDate: '2023-06-01', endDate: '2026-02-28' },
  { charity: 'Mermaids',                  amount: 13, startDate: '2023-06-01', endDate: '2026-02-28' },
  { charity: 'Give Directly',             amount: 30, startDate: '2026-03-01', endDate: null },
  { charity: 'Give Well top charities fund', amount: 60, startDate: '2026-03-01', endDate: null },
  { charity: 'Pump Aid',                  amount: 15, startDate: '2026-03-01', endDate: null },
];

async function computeCharitySummary() {
  // One-time seed of the known donation history (guarded by a synced flag).
  if (!(await getSetting('charitySeeded'))) {
    const existingCount = await db.charityDonations.count();
    if (existingCount === 0) {
      for (const row of CHARITY_SEED) {
        const id = await db.charityDonations.add({ ...row });
        queueWrite('charityDonations', id).catch(() => {});
      }
    }
    await setSetting('charitySeeded', true);
    queueWrite('settings', 'charitySeeded').catch(() => {});
  }

  const rows = await db.charityDonations.toArray();
  const t = today();

  const enriched = rows.map(r => {
    const months = charityMonthsActive(r.startDate, r.endDate);
    const total = (Number(r.amount) || 0) * months;
    const active = r.startDate <= t && (!r.endDate || r.endDate >= t);
    return { ...r, months, total, active };
  });

  // Aggregate total donated per charity (across all commitments)
  const byCharity = {};
  for (const e of enriched) {
    if (!byCharity[e.charity]) byCharity[e.charity] = { charity: e.charity, total: 0, active: false, activeAmount: 0 };
    byCharity[e.charity].total += e.total;
    if (e.active) { byCharity[e.charity].active = true; byCharity[e.charity].activeAmount += (Number(e.amount) || 0); }
  }
  const ranking = Object.values(byCharity).sort((a, b) => b.total - a.total);

  const grandTotal = enriched.reduce((s, e) => s + e.total, 0);
  const currentMonthly = enriched.filter(e => e.active).reduce((s, e) => s + (Number(e.amount) || 0), 0);

  // Commitments list: active first, then by most recent start
  const commitments = enriched.sort((a, b) => (b.active - a.active) || (b.startDate || '').localeCompare(a.startDate || ''));

  return { ranking, grandTotal, currentMonthly, commitments };
}

async function renderCharity() {
  const s = await computeCharitySummary();
  const back = `<button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>`;

  const maxTotal = Math.max(1, ...s.ranking.map(r => r.total));
  const rankRows = s.ranking.map(r => `
    <div style="padding:8px 14px;border-bottom:1px solid var(--border)">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:4px">
        <span style="font-size:14px">${r.charity}${r.active ? ` <span style="font-size:11px;color:#43a047">· ${fmt(r.activeAmount)}/mo now</span>` : ''}</span>
        <span style="font-weight:700;font-size:14px">${fmt(r.total)}</span>
      </div>
      <div style="height:6px;background:var(--bg);border-radius:3px;overflow:hidden">
        <div style="height:100%;width:${(r.total / maxTotal * 100).toFixed(1)}%;background:#e91e8c"></div>
      </div>
    </div>`).join('');

  const cList = s.commitments.map(c => `
    <div class="settings-row ch-row" data-id="${c.id}" style="cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px">${c.charity} · ${fmt(Number(c.amount) || 0)}/mo</div>
        <div style="font-size:12px;color:var(--text-2)">${fmtDate(c.startDate)} → ${c.endDate ? fmtDate(c.endDate) : 'ongoing'} · ${c.months} mo · ${fmt(c.total)} total${c.active ? ' · active' : ''}</div>
      </div>
      <span class="settings-row-chevron">›</span>
    </div>`).join('');

  viewContainer.innerHTML = `
    <div class="settings-screen">
      <div class="screen-header">${back}<span class="screen-title">Charity donations</span><div style="width:34px"></div></div>

      <div style="text-align:center;padding:16px 16px 6px">
        <div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Total donated to date</div>
        <div style="font-size:32px;font-weight:800">${fmt(s.grandTotal)}</div>
        <div style="font-size:13px;color:#e91e8c;margin-top:2px">Currently giving ${fmt(s.currentMonthly)}/mo</div>
      </div>

      <div style="padding:12px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">Total given by charity</div>
      ${s.ranking.length === 0
        ? `<div style="padding:8px 16px;color:var(--text-2);font-size:13px">No donations logged yet.</div>`
        : `<div class="settings-card" style="margin:4px 12px;padding:2px 0">${rankRows}</div>`}

      <div style="padding:14px 12px 8px">
        <button class="btn btn-primary btn-full" id="ch-log">＋ Log a donation change</button>
      </div>

      <div style="padding:10px 16px 2px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-2)">All commitments</div>
      ${s.commitments.length === 0
        ? `<div style="padding:8px 16px;color:var(--text-2);font-size:13px">None yet.</div>`
        : `<div class="settings-card" style="margin:4px 12px">${cList}</div>`}
      <div style="padding-bottom:80px"></div>
    </div>`;

  const reRender = () => renderCharity();
  viewContainer.querySelector('#ch-log').onclick = () => openCharityEditor(null, reRender);
  viewContainer.querySelectorAll('.ch-row').forEach(r => r.onclick = () => {
    const c = s.commitments.find(x => x.id === Number(r.dataset.id));
    if (c) openCharityEditor(c, reRender);
  });
}

async function openCharityEditor(existing, onSaved) {
  let charity = existing?.charity ?? '';
  let amount = existing?.amount ?? 0;
  let startDate = existing?.startDate ?? today();
  let endDate = existing?.endDate ?? null;
  let ongoing = !existing?.endDate;
  let note = existing?.note ?? '';

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${existing ? 'Edit' : 'Log'} donation</span>
        <button class="sheet-close" id="ch-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group">
          <label class="form-label">Charity</label>
          <input class="form-input" type="text" id="ch-name" value="${charity}" placeholder="e.g. Give Directly" maxlength="120">
        </div>
        <div class="form-group" style="cursor:pointer" id="ch-amount-row">
          <label class="form-label">Monthly amount</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="ch-amount-disp" style="font-size:16px;font-weight:600">${amount > 0 ? fmt(amount) : 'Tap to enter'}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="ch-start-row">
          <label class="form-label">Start date</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="ch-start-disp">${fmtDate(startDate)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="display:flex;align-items:center;justify-content:space-between;padding:10px 0">
          <label style="font-size:14px;font-weight:500">Still giving (ongoing)</label>
          <input type="checkbox" id="ch-ongoing" ${ongoing ? 'checked' : ''} style="width:18px;height:18px">
        </div>
        <div class="form-group" id="ch-end-group" style="display:${ongoing ? 'none' : 'block'}">
          <div class="form-group" style="cursor:pointer;margin-bottom:0" id="ch-end-row">
            <label class="form-label">End date</label>
            <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
              <span id="ch-end-disp">${fmtDate(endDate ?? today())}</span><span style="color:var(--text-2)">›</span>
            </div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Note (optional)</label>
          <input class="form-input" type="text" id="ch-note" value="${note}" placeholder="e.g. AmEx card monthly" maxlength="200">
        </div>
        ${existing ? `<button class="btn btn-danger btn-full" id="ch-del" style="margin-bottom:8px">Delete</button>` : ''}
        <button class="btn btn-primary btn-full" id="ch-save">Save</button>
      </div>
    </div>`;

  overlay.querySelector('#ch-close').onclick = () => overlay.remove();
  overlay.querySelector('#ch-name').oninput = e => { charity = e.target.value; };
  overlay.querySelector('#ch-start-row').onclick = () => openDatePicker(startDate, today(), d => { startDate = d; overlay.querySelector('#ch-start-disp').textContent = fmtDate(d); });
  overlay.querySelector('#ch-note').oninput = e => { note = e.target.value; };
  overlay.querySelector('#ch-end-row').onclick = () => openDatePicker(endDate ?? today(), today(), d => { endDate = d; overlay.querySelector('#ch-end-disp').textContent = fmtDate(d); });
  overlay.querySelector('#ch-ongoing').onchange = e => {
    ongoing = e.target.checked;
    overlay.querySelector('#ch-end-group').style.display = ongoing ? 'none' : 'block';
  };
  overlay.querySelector('#ch-amount-row').onclick = () => openAmountPad('Monthly amount', amount, v => { amount = Math.max(0, v); overlay.querySelector('#ch-amount-disp').textContent = amount > 0 ? fmt(amount) : 'Tap to enter'; }, { noNegative: true });

  overlay.querySelector('#ch-save').onclick = async () => {
    if (!charity.trim()) { showToast('Enter a charity name'); return; }
    if ((amount || 0) <= 0) { showToast('Enter an amount'); return; }
    const rec = {
      charity: charity.trim(), amount: amount || 0, startDate,
      endDate: ongoing ? null : (endDate || null),
      note: note.trim(),
    };
    if (existing) {
      await db.charityDonations.update(existing.id, rec);
      queueWrite('charityDonations', existing.id).catch(() => {});
    } else {
      const id = await db.charityDonations.add(rec);
      queueWrite('charityDonations', id).catch(() => {});
    }
    overlay.remove();
    showToast(existing ? 'Donation updated' : 'Donation logged');
    onSaved?.();
  };

  overlay.querySelector('#ch-del')?.addEventListener('click', async () => {
    await db.charityDonations.delete(existing.id);
    queueDelete('charityDonations', existing.id).catch(() => {});
    overlay.remove();
    showToast('Donation deleted');
    onSaved?.();
  });
}

// ── Financial goals: pension maximising ───────────────────────────────────────
// Logs APC (Additional Pension Contribution) purchases — each buys a chunk of
// extra *annual* pension into the LGPS pot. There's a lifetime cap on how much
// extra annual pension you can buy this way (£9,054 for 2026/7, revised yearly);
// the core goal is to reach that cap. The page also surfaces the headline
// benefits from the latest annual pension statement (current pension + what it's
// projected to be at various retirement ages).

// Known APC history (seeded once, then user-editable). `pensionBought` is the
// extra yearly pension that purchase adds; costs are as originally paid.
const APC_SEED = [
  { date: '2020-01-01', cost: 1500,   pensionBought: 218.02,  contract: 'Single',                 note: 'One-off lump sum' },
  { date: '2020-06-01', cost: 266.67, pensionBought: 445.49,  contract: '1 year',                 note: '' },
  { date: '2021-08-01', cost: 350.22, pensionBought: 573.00,  contract: '1 year',                 note: '' },
  { date: '2022-08-01', cost: 771.14, pensionBought: 2761.16, contract: 'Finished 31/07/25',      note: '£600/mo, rose to £771.14/mo from 01/04/24', endDate: '2025-07-31' },
  { date: '2025-10-01', cost: 800,    pensionBought: 2742.54, contract: 'Due to finish 30/09/28',  note: '', endDate: '2028-09-30' },
];

// Headline figures from the annual pension statement (31 Mar 2026). Stored as
// settings so they can be refreshed each year without a code change.
const PENSION_DEFAULTS = {
  pensionMaxApc: 9054,           // max extra annual pension buyable via APC (2026/7)
  pensionCurrentAnnual: 18200.36,// current yearly pension at the statement date
  pensionStatementDate: '2026-03-31',
  pensionPensionablePay: 69892,
  pensionDeathGrant: 209676,
  pensionPartnerPension: 18433.96,
  pensionEstimates: JSON.stringify([
    { label: 'Age 55', year: 2045, pension: 27533.58, maxLumpSum: 118001.04, maxLumpPension: 17700.16 },
    { label: 'Age 60', year: 2050, pension: 39179.29, maxLumpSum: 167911.20, maxLumpPension: 25186.69 },
    { label: 'Age 65', year: 2055, pension: 54791.82, maxLumpSum: 234822.00, maxLumpPension: 35223.32 },
    { label: 'State pension', year: 2058, pension: 67622.25, maxLumpSum: 268275.00, maxLumpPension: 45266.00 },
  ]),
};

async function computePensionSummary() {
  // One-time seed of the known APC history + statement figures (guarded flag).
  if (!(await getSetting('pensionSeeded'))) {
    if ((await db.apcPurchases.count()) === 0) {
      for (const row of APC_SEED) {
        const id = await db.apcPurchases.add({ ...row });
        queueWrite('apcPurchases', id).catch(() => {});
      }
    }
    for (const [k, v] of Object.entries(PENSION_DEFAULTS)) {
      if ((await getSetting(k)) == null) {
        await setSetting(k, v);
        queueWrite('settings', k).catch(() => {});
      }
    }
    await setSetting('pensionSeeded', true);
    queueWrite('settings', 'pensionSeeded').catch(() => {});
  }

  const purchases = (await db.apcPurchases.toArray())
    .sort((a, b) => (a.date || '').localeCompare(b.date || ''));

  const maxApc = Number(await getSetting('pensionMaxApc')) || PENSION_DEFAULTS.pensionMaxApc;
  const currentAnnual = Number(await getSetting('pensionCurrentAnnual')) || 0;
  const statementDate = (await getSetting('pensionStatementDate')) || PENSION_DEFAULTS.pensionStatementDate;
  const deathGrant = Number(await getSetting('pensionDeathGrant')) || 0;
  const partnerPension = Number(await getSetting('pensionPartnerPension')) || 0;
  let estimates = [];
  try { estimates = JSON.parse((await getSetting('pensionEstimates')) || PENSION_DEFAULTS.pensionEstimates); } catch { estimates = []; }

  const totalBought = purchases.reduce((s, p) => s + (Number(p.pensionBought) || 0), 0);
  const remaining = Math.max(0, maxApc - totalBought);
  const pctToMax = maxApc > 0 ? Math.min(100, totalBought / maxApc * 100) : 0;
  const t = today();
  const enriched = purchases.map(p => ({
    ...p,
    active: !p.endDate || p.endDate >= t,
  })).sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  return {
    purchases: enriched, totalBought, maxApc, remaining, pctToMax,
    currentAnnual, statementDate, estimates, deathGrant, partnerPension,
  };
}

function drawPensionChart(canvas, currentAnnual, estimates) {
  if (!canvas || typeof Chart === 'undefined' || !estimates.length) return;
  const labels = ['Now', ...estimates.map(e => e.label)];
  const data = [currentAnnual, ...estimates.map(e => Number(e.pension) || 0)];
  const colours = ['#9e9e9e', ...estimates.map(() => '#3f51b5')];
  if (canvas._chart) canvas._chart.destroy();
  canvas._chart = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: { labels, datasets: [{ data, backgroundColor: colours, borderRadius: 6, maxBarThickness: 46 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${fmt(c.parsed.y)}/yr` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 } } },
        y: { grid: { color: 'rgba(0,0,0,0.06)' }, ticks: { font: { size: 10 }, callback: v => v >= 1000 ? `£${(v / 1000).toFixed(0)}k` : `£${v}` } },
      },
    },
  });
}

async function renderPension() {
  const s = await computePensionSummary();
  const back = `<button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>`;

  const apcList = s.purchases.map(p => `
    <div class="settings-row apc-row" data-id="${p.id}" style="cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px">${fmtDate(p.date)} · +${fmt(Number(p.pensionBought) || 0)}/yr pension</div>
        <div style="font-size:12px;color:var(--text-2)">${p.contract || ''}${p.cost ? ` · ${fmt(Number(p.cost) || 0)} cost` : ''}${p.active ? ' · active' : ''}${p.note ? `<br>${p.note}` : ''}</div>
      </div>
      <span class="settings-row-chevron">›</span>
    </div>`).join('');

  const estRows = s.estimates.map((e, i) => `
    <div class="settings-row pen-est-row" data-idx="${i}" style="cursor:pointer">
      <div style="flex:1;min-width:0">
        <div style="font-size:14px;font-weight:600">${e.label}${e.year ? ` <span style="font-weight:400;color:var(--text-2)">(${e.year})</span>` : ''}</div>
        <div style="font-size:12px;color:var(--text-2)">Or max lump ${fmt(Number(e.maxLumpSum) || 0)} + ${fmt(Number(e.maxLumpPension) || 0)}/yr</div>
      </div>
      <span style="font-weight:700;font-size:15px;color:#3f51b5">${fmt(Number(e.pension) || 0)}<span style="font-size:11px;font-weight:400;color:var(--text-2)">/yr</span></span>
    </div>`).join('');

  viewContainer.innerHTML = `
    <div class="settings-screen">
      <div class="screen-header">${back}<span class="screen-title">Pension maximising</span><div style="width:34px"></div></div>

      <div style="text-align:center;padding:16px 16px 6px">
        <div style="font-size:12px;color:var(--text-2);text-transform:uppercase;letter-spacing:.05em">Extra pension bought via APCs</div>
        <div style="font-size:34px;font-weight:800;color:#3f51b5;line-height:1.1;margin-top:4px">${fmt(s.totalBought)}<span style="font-size:16px;color:var(--text-2)">/yr</span></div>
        <div style="font-size:13px;color:var(--text-2);margin-top:2px">of ${fmt(s.maxApc)}/yr lifetime cap</div>
      </div>

      <div style="padding:6px 16px 12px">
        <div style="height:12px;background:var(--bg);border-radius:6px;overflow:hidden">
          <div style="height:100%;width:${s.pctToMax.toFixed(1)}%;background:linear-gradient(90deg,#3f51b5,#7986cb)"></div>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-2);margin-top:6px">
          <span>${s.pctToMax.toFixed(0)}% of cap reached</span>
          <span>${fmt(s.remaining)}/yr left to buy</span>
        </div>
      </div>

      <div class="settings-card" style="margin:4px 12px 0">
        <div class="settings-row" id="pen-max"><span class="settings-row-label">APC lifetime cap (per year)</span><span style="color:var(--text-2)">${fmt(s.maxApc)} ›</span></div>
      </div>
      <div style="padding:6px 16px 0;font-size:11px;color:var(--text-2)">The cap is revised each year — update it from wypf.org.uk (APC page).</div>

      <div class="settings-section-title" style="padding:16px 16px 6px">APC purchases</div>
      <button class="btn btn-primary btn-full" id="apc-log" style="margin:0 12px 6px;width:calc(100% - 24px)">+ Log an APC purchase</button>
      ${s.purchases.length === 0
        ? `<div style="padding:8px 16px;color:var(--text-2);font-size:13px">None yet. Log your first APC above.</div>`
        : `<div class="settings-card" style="margin:4px 12px">${apcList}</div>`}

      <div class="settings-section-title" style="padding:20px 16px 6px">Your pension benefits</div>
      <div style="padding:0 16px 4px;font-size:12px;color:var(--text-2)">Current yearly pension as of ${fmtDate(s.statementDate)}</div>
      <div class="settings-card" style="margin:4px 12px 0">
        <div class="settings-row" id="pen-current"><span class="settings-row-label">Current yearly pension</span><span style="color:var(--text-2)">${fmt(s.currentAnnual)} ›</span></div>
      </div>

      <div style="padding:16px 16px 4px;font-size:13px;font-weight:600">Projected pension by retirement age</div>
      <div style="height:200px;padding:0 12px 8px"><canvas id="pen-chart"></canvas></div>
      <div class="settings-card" style="margin:4px 12px">${estRows}</div>
      <div style="padding:6px 16px 0;font-size:11px;color:var(--text-2)">Standard yearly pension shown. Tap a row to give up pension for a bigger one-off lump sum instead, or to update figures from a new statement.</div>

      <div class="settings-section-title" style="padding:20px 16px 6px">If you die before leaving this job</div>
      <div class="settings-card" style="margin:4px 12px 0">
        <div class="settings-row"><span class="settings-row-label">One-off death grant</span><span style="font-weight:600">${fmt(s.deathGrant)}</span></div>
        <div class="settings-row"><span class="settings-row-label">Partner's pension (yearly)</span><span style="font-weight:600">${fmt(s.partnerPension)}</span></div>
      </div>

      <div style="padding-bottom:90px"></div>
    </div>`;

  const reRender = () => renderPension();
  viewContainer.querySelector('#pen-max').onclick = () => openAmountPad('APC lifetime cap (per year)', s.maxApc, v => {
    setSetting('pensionMaxApc', Math.max(0, v)).then(() => { queueWrite('settings', 'pensionMaxApc').catch(() => {}); reRender(); });
  }, { noNegative: true });
  viewContainer.querySelector('#pen-current').onclick = () => openAmountPad('Current yearly pension', s.currentAnnual, v => {
    setSetting('pensionCurrentAnnual', Math.max(0, v)).then(() => { queueWrite('settings', 'pensionCurrentAnnual').catch(() => {}); reRender(); });
  }, { noNegative: true });
  viewContainer.querySelector('#apc-log').onclick = () => openApcEditor(null, reRender);
  viewContainer.querySelectorAll('.apc-row').forEach(r => r.onclick = () => {
    const p = s.purchases.find(x => x.id === Number(r.dataset.id));
    if (p) openApcEditor(p, reRender);
  });
  viewContainer.querySelectorAll('.pen-est-row').forEach(r => r.onclick = () => {
    openPensionEstimateEditor(Number(r.dataset.idx), s.estimates, reRender);
  });
  drawPensionChart(viewContainer.querySelector('#pen-chart'), s.currentAnnual, s.estimates);
}

async function openApcEditor(existing, onSaved) {
  let oDate = existing?.date ?? today();
  let cost = existing?.cost ?? 0;
  let pensionBought = existing?.pensionBought ?? 0;
  let contract = existing?.contract ?? '';
  let note = existing?.note ?? '';
  let endDate = existing?.endDate ?? null;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${existing ? 'Edit' : 'Log'} APC purchase</span>
        <button class="sheet-close" id="ap-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group" style="cursor:pointer" id="ap-date-row">
          <label class="form-label">Purchase / start date</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="ap-date-disp">${fmtDate(oDate)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="ap-pension-row">
          <label class="form-label">Extra yearly pension bought</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="ap-pension-disp" style="font-size:16px;font-weight:600">${pensionBought > 0 ? fmt(pensionBought) : 'Tap to enter'}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="ap-cost-row">
          <label class="form-label">Cost</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="ap-cost-disp" style="font-size:16px;font-weight:600">${cost > 0 ? fmt(cost) : 'Tap to enter'}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Contract length / status</label>
          <input class="form-input" type="text" id="ap-contract" value="${contract}" placeholder="e.g. 1 year, Single, Due to finish 30/09/28" maxlength="120">
        </div>
        <div class="form-group" style="cursor:pointer" id="ap-end-row">
          <label class="form-label">End date (optional)</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="ap-end-disp">${endDate ? fmtDate(endDate) : 'None (ongoing / single)'}</span>
            <span style="display:flex;gap:8px;align-items:center">${endDate ? `<span id="ap-end-clear" style="color:#f44336;font-size:13px">clear</span>` : ''}<span style="color:var(--text-2)">›</span></span>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">Note (optional)</label>
          <input class="form-input" type="text" id="ap-note" value="${note}" placeholder="e.g. rate rose partway through" maxlength="200">
        </div>
        ${existing ? `<button class="btn btn-danger btn-full" id="ap-del" style="margin-bottom:8px">Delete</button>` : ''}
        <button class="btn btn-primary btn-full" id="ap-save">Save</button>
      </div>
    </div>`;

  overlay.querySelector('#ap-close').onclick = () => overlay.remove();
  overlay.querySelector('#ap-date-row').onclick = () => openDatePicker(oDate, today(), d => { oDate = d; overlay.querySelector('#ap-date-disp').textContent = fmtDate(d); });
  overlay.querySelector('#ap-pension-row').onclick = () => openAmountPad('Extra yearly pension bought', pensionBought, v => { pensionBought = Math.max(0, v); overlay.querySelector('#ap-pension-disp').textContent = pensionBought > 0 ? fmt(pensionBought) : 'Tap to enter'; }, { noNegative: true });
  overlay.querySelector('#ap-cost-row').onclick = () => openAmountPad('Cost', cost, v => { cost = Math.max(0, v); overlay.querySelector('#ap-cost-disp').textContent = cost > 0 ? fmt(cost) : 'Tap to enter'; }, { noNegative: true });
  overlay.querySelector('#ap-contract').oninput = e => { contract = e.target.value; };
  overlay.querySelector('#ap-note').oninput = e => { note = e.target.value; };
  const bindEndClear = () => {
    const c = overlay.querySelector('#ap-end-clear');
    if (c) c.onclick = ev => { ev.stopPropagation(); endDate = null; refreshEnd(); };
  };
  const refreshEnd = () => {
    overlay.querySelector('#ap-end-disp').textContent = endDate ? fmtDate(endDate) : 'None (ongoing / single)';
    const wrap = overlay.querySelector('#ap-end-row .form-input > span:last-child');
    wrap.innerHTML = `${endDate ? `<span id="ap-end-clear" style="color:#f44336;font-size:13px">clear</span>` : ''}<span style="color:var(--text-2)">›</span>`;
    bindEndClear();
  };
  overlay.querySelector('#ap-end-row').onclick = () => openDatePicker(endDate ?? today(), '2099-12-31', d => { endDate = d; refreshEnd(); });
  bindEndClear();

  overlay.querySelector('#ap-save').onclick = async () => {
    if ((pensionBought || 0) <= 0) { showToast('Enter the pension bought'); return; }
    const rec = { date: oDate, cost: cost || 0, pensionBought: pensionBought || 0, contract: contract.trim(), note: note.trim(), endDate: endDate || null };
    if (existing) {
      await db.apcPurchases.update(existing.id, rec);
      queueWrite('apcPurchases', existing.id).catch(() => {});
    } else {
      const id = await db.apcPurchases.add(rec);
      queueWrite('apcPurchases', id).catch(() => {});
    }
    overlay.remove();
    showToast(existing ? 'APC updated' : 'APC logged');
    onSaved?.();
  };

  overlay.querySelector('#ap-del')?.addEventListener('click', async () => {
    await db.apcPurchases.delete(existing.id);
    queueDelete('apcPurchases', existing.id).catch(() => {});
    overlay.remove();
    showToast('APC deleted');
    onSaved?.();
  });
}

// Edit one retirement-age estimate (from the annual statement). Persists the
// whole estimates array back as a JSON setting.
async function openPensionEstimateEditor(idx, estimates, onSaved) {
  const est = { ...estimates[idx] };
  let pension = Number(est.pension) || 0;
  let maxLumpSum = Number(est.maxLumpSum) || 0;
  let maxLumpPension = Number(est.maxLumpPension) || 0;

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  overlay.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${est.label}${est.year ? ` (${est.year})` : ''}</span>
        <button class="sheet-close" id="pe-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group">
          <label class="form-label">Label</label>
          <input class="form-input" type="text" id="pe-label" value="${est.label ?? ''}" maxlength="40">
        </div>
        <div class="form-group">
          <label class="form-label">Year</label>
          <input class="form-input" type="number" id="pe-year" value="${est.year ?? ''}" placeholder="e.g. 2045">
        </div>
        <div class="form-group" style="cursor:pointer" id="pe-pension-row">
          <label class="form-label">Standard yearly pension</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="pe-pension-disp" style="font-size:16px;font-weight:600">${fmt(pension)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="pe-lumpsum-row">
          <label class="form-label">Max one-off lump sum</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="pe-lumpsum-disp" style="font-size:16px;font-weight:600">${fmt(maxLumpSum)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <div class="form-group" style="cursor:pointer" id="pe-lumppension-row">
          <label class="form-label">Reduced yearly pension (with max lump)</label>
          <div class="form-input" style="display:flex;align-items:center;justify-content:space-between">
            <span id="pe-lumppension-disp" style="font-size:16px;font-weight:600">${fmt(maxLumpPension)}</span><span style="color:var(--text-2)">›</span>
          </div>
        </div>
        <button class="btn btn-primary btn-full" id="pe-save">Save</button>
      </div>
    </div>`;

  overlay.querySelector('#pe-close').onclick = () => overlay.remove();
  overlay.querySelector('#pe-pension-row').onclick = () => openAmountPad('Standard yearly pension', pension, v => { pension = Math.max(0, v); overlay.querySelector('#pe-pension-disp').textContent = fmt(pension); }, { noNegative: true });
  overlay.querySelector('#pe-lumpsum-row').onclick = () => openAmountPad('Max one-off lump sum', maxLumpSum, v => { maxLumpSum = Math.max(0, v); overlay.querySelector('#pe-lumpsum-disp').textContent = fmt(maxLumpSum); }, { noNegative: true });
  overlay.querySelector('#pe-lumppension-row').onclick = () => openAmountPad('Reduced yearly pension (with max lump)', maxLumpPension, v => { maxLumpPension = Math.max(0, v); overlay.querySelector('#pe-lumppension-disp').textContent = fmt(maxLumpPension); }, { noNegative: true });

  overlay.querySelector('#pe-save').onclick = async () => {
    const next = estimates.map(e => ({ ...e }));
    next[idx] = {
      label: overlay.querySelector('#pe-label').value.trim() || est.label,
      year: Number(overlay.querySelector('#pe-year').value) || est.year,
      pension, maxLumpSum, maxLumpPension,
    };
    await setSetting('pensionEstimates', JSON.stringify(next));
    queueWrite('settings', 'pensionEstimates').catch(() => {});
    overlay.remove();
    showToast('Estimate updated');
    onSaved?.();
  };
}

async function openAccountRatesEditor() {
  const accounts = (await db.accounts.orderBy('sortOrder').toArray())
    .filter(a => a.isActive !== false && ['savings','mortgage'].includes(reconcileTypeForAccount(a)));
  let allRates = await db.accountRates.toArray();

  const overlay = document.createElement('div');
  overlay.className = 'sheet-overlay';
  document.body.appendChild(overlay);
  overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };

  function build() {
    const byAcc = {};
    for (const r of allRates) { (byAcc[r.accountId] = byAcc[r.accountId] ?? []).push(r); }

    overlay.innerHTML = `
      <div class="sheet" style="max-height:88vh">
        <div class="sheet-handle"></div>
        <div class="sheet-header">
          <span class="sheet-title">Account rates</span>
          <button class="sheet-close" id="ar-close">✕</button>
        </div>
        <div class="sheet-body" style="padding:12px 16px;overflow-y:auto;max-height:calc(88vh - 60px)">
          <div style="font-size:13px;color:var(--text-2);margin-bottom:12px;line-height:1.5">Interest rates used to estimate savings growth and mortgage capital repayment in the reconciliation. Tap a rate to edit, or add a new period when a rate changes.</div>
          ${accounts.map(acc => {
            const rates = (byAcc[acc.id] ?? []).sort((a, b) => b.startDate.localeCompare(a.startDate));
            const isMtg = reconcileTypeForAccount(acc) === 'mortgage';
            return `
              <div style="margin-bottom:16px">
                <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.04em;color:var(--text-2);margin-bottom:4px">${acc.name}</div>
                <div class="settings-card">
                  ${rates.length === 0 ? `<div class="settings-row" style="color:var(--text-2);font-size:13px">No rates logged</div>` : ''}
                  ${rates.map(r => `
                    <div class="settings-row ar-row" data-rate-id="${r.id}" style="cursor:pointer">
                      <div style="flex:1">
                        <div style="font-size:14px">${r.rate}% AER${isMtg && r.monthlyPayment ? ` · £${fmt(r.monthlyPayment)}/mo payment` : ''}</div>
                        <div style="font-size:12px;color:var(--text-2)">Until ${r.endDate ? new Date(r.endDate + 'T12:00:00').toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric'}) : 'indefinite'}</div>
                      </div>
                      <span class="settings-row-chevron">›</span>
                    </div>`).join('')}
                </div>
                <button class="btn ar-add-btn" data-acc-id="${acc.id}" data-is-mtg="${isMtg}" style="margin-top:4px;width:100%;font-size:13px">+ Add rate period</button>
              </div>`;
          }).join('')}
        </div>
      </div>`;

    overlay.querySelector('#ar-close').onclick = () => overlay.remove();

    overlay.querySelectorAll('.ar-row').forEach(row => {
      row.addEventListener('click', () => {
        const r = allRates.find(x => x.id === Number(row.dataset.rateId));
        const acc = accounts.find(a => a.id === r?.accountId);
        if (r && acc) openRatePeriodForm(acc, r, async () => { allRates = await db.accountRates.toArray(); build(); });
      });
    });

    overlay.querySelectorAll('.ar-add-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const acc = accounts.find(a => a.id === Number(btn.dataset.accId));
        if (acc) openRatePeriodForm(acc, null, async () => { allRates = await db.accountRates.toArray(); build(); });
      });
    });
  }
  build();
}

function openRatePeriodForm(acc, existing, onSave) {
  const isMtg = reconcileTypeForAccount(acc) === 'mortgage';
  const overlay2 = document.createElement('div');
  overlay2.className = 'sheet-overlay';
  overlay2.innerHTML = `
    <div class="sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-header">
        <span class="sheet-title">${existing ? 'Edit' : 'Add'} rate – ${acc.name}</span>
        <button class="sheet-close" id="rpf-close">✕</button>
      </div>
      <div class="sheet-body" style="padding:16px">
        <div class="form-group">
          <label class="form-label">Interest rate (% AER)</label>
          <input class="form-input" type="number" id="rpf-rate" value="${existing?.rate ?? ''}" step="0.01" min="0" max="30" placeholder="e.g. 4.23">
        </div>
        <div class="form-group">
          <label class="form-label">Rate valid until (leave blank if ongoing)</label>
          <input class="form-input" type="date" id="rpf-end" value="${existing?.endDate ?? ''}">
        </div>
        ${isMtg ? `
          <div class="form-group">
            <label class="form-label">Full monthly payment leaving your account (£)</label>
            <input class="form-input" type="number" id="rpf-pay" value="${existing?.monthlyPayment ?? ''}" step="0.01" min="0" placeholder="e.g. 1073.17">
          </div>` : ''}
        ${existing ? `<button class="btn btn-danger btn-full" id="rpf-del" style="margin-bottom:8px">Delete this rate period</button>` : ''}
        <button class="btn btn-primary btn-full" id="rpf-save">Save</button>
      </div>
    </div>`;
  document.body.appendChild(overlay2);
  overlay2.onclick = e => { if (e.target === overlay2) overlay2.remove(); };
  overlay2.querySelector('#rpf-close').onclick = () => overlay2.remove();

  overlay2.querySelector('#rpf-save').onclick = async () => {
    const rateVal = parseFloat(overlay2.querySelector('#rpf-rate').value);
    if (!rateVal || rateVal <= 0) { showToast('Enter a valid rate'); return; }
    const endDateVal = overlay2.querySelector('#rpf-end').value || null;
    const payVal = isMtg ? (parseFloat(overlay2.querySelector('#rpf-pay').value) || null) : undefined;
    const rec = { accountId: acc.id, rate: rateVal, startDate: existing?.startDate ?? today(), endDate: endDateVal };
    if (payVal != null) rec.monthlyPayment = payVal;
    if (existing) {
      await db.accountRates.update(existing.id, rec);
      queueWrite('accountRates', existing.id).catch(() => {});
    } else {
      const id = await db.accountRates.add(rec);
      queueWrite('accountRates', id).catch(() => {});
    }
    overlay2.remove();
    showToast('Rate saved');
    onSave?.();
  };

  overlay2.querySelector('#rpf-del')?.addEventListener('click', async () => {
    await db.accountRates.delete(existing.id);
    queueDelete('accountRates', existing.id).catch(() => {});
    overlay2.remove();
    showToast('Rate deleted');
    onSave?.();
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
        openAmountPad(`Inflation – ${new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}`, cur, val => {
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

async function renderBankGilulu(activeHoldingId = 'summary') {
  const holdings = await db.friendHoldings.filter(h => h.isActive !== false).toArray();

  const ratePeriods = await getGlobalRatePeriods();
  const currentRateEntry = [...ratePeriods].sort((a, b) => b.fromDate.localeCompare(a.fromDate))[0];
  const currentRate = currentRateEntry?.rate ?? null;
  const toDate = today();

  // Summary is the default landing view: it aggregates every account's balance
  // (with interest) and charts the combined total held in the bank over time.
  if ((activeHoldingId === 'summary' || activeHoldingId == null) && holdings.length > 0) {
    await renderBgSummary(holdings, ratePeriods, currentRate, toDate);
    return;
  }

  let holding = (activeHoldingId && activeHoldingId !== 'summary')
    ? holdings.find(h => h.id === activeHoldingId)
    : holdings[0];

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
    return `<button class="pill-btn" data-holding-id="summary">📊 Summary</button>` +
      holdings.map(h => `
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
        <button class="icon-btn" onclick="window.app.goBack()">
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

        <!-- Balance card – screenshot-friendly -->
        <div style="margin:12px;padding:20px;background:var(--card);border-radius:var(--radius);box-shadow:0 1px 4px rgba(0,0,0,.08)">
          <div style="font-size:12px;color:var(--text-2);font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px">
            Bank of Gilulu – ${bgHoldingName(holding)}
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
    btn.addEventListener('click', () => {
      const val = btn.dataset.holdingId;
      renderBankGilulu(val === 'summary' ? 'summary' : Number(val));
    });
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

async function renderBgSummary(holdings, ratePeriods, currentRate, toDate) {
  const allHoldingTxs = await Promise.all(
    holdings.map(h => db.friendTransactions.where('holdingId').equals(h.id).sortBy('date'))
  );
  const feb1 = `${new Date().getFullYear()}-02-01`;

  const perHolding = holdings.map((h, i) => {
    const txs = allHoldingTxs[i];
    const total = bgTotalWithInterest(txs, ratePeriods, toDate);
    const principal = txs.reduce((s, t) => s + t.amount, 0);
    const thisYearInterest = txs.reduce((s, t) => {
      const eff = t.date > feb1 ? t.date : feb1;
      if (eff >= toDate) return s;
      return s + bgInterestOnAmount(t.amount, eff, ratePeriods, toDate);
    }, 0);
    return { holding: h, txs, total, principal, interest: total - principal, thisYearInterest };
  });
  // Largest balances first so the summary reads top-down by size
  perHolding.sort((a, b) => b.total - a.total);

  const grandTotal = perHolding.reduce((s, p) => s + p.total, 0);
  const grandPrincipal = perHolding.reduce((s, p) => s + p.principal, 0);
  const grandInterest = grandTotal - grandPrincipal;
  const grandThisYearInterest = perHolding.reduce((s, p) => s + p.thisYearInterest, 0);

  // Combined "in the bank" over time: at each date, sum every account's
  // balance-with-interest accrued to that date.
  const allTxDates = allHoldingTxs.flat().map(t => t.date);
  const chartDates = [...new Set([...allTxDates, toDate])].sort();
  const chartValues = chartDates.map(d =>
    perHolding.reduce((s, p) => s + bgTotalWithInterest(p.txs.filter(t => t.date <= d), ratePeriods, d), 0)
  );
  const hasChart = allTxDates.length > 0;

  const pillsHTML = `<button class="pill-btn active" data-holding-id="summary">📊 Summary</button>` +
    holdings.map(h => `<button class="pill-btn" data-holding-id="${h.id}">${bgHoldingName(h)}</button>`).join('') +
    `<button class="pill-btn" id="bg-add-account">+ Add</button>`;

  viewContainer.innerHTML = `
    <div class="settings-screen" id="bg-screen">
      <div class="screen-header">
        <button class="icon-btn" onclick="window.app.goBack()">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <span class="screen-title">Bank of Gilulu</span>
        <div style="width:36px"></div>
      </div>

      <div style="padding:10px 12px 0;display:flex;gap:6px;flex-wrap:wrap;align-items:center">
        ${pillsHTML}
      </div>

      <!-- Combined balance card -->
      <div style="margin:12px;padding:20px;background:var(--card);border-radius:var(--radius);box-shadow:0 1px 4px rgba(0,0,0,.08)">
        <div style="font-size:12px;color:var(--text-2);font-weight:600;letter-spacing:.5px;text-transform:uppercase;margin-bottom:4px">
          Total in the bank · ${holdings.length} account${holdings.length === 1 ? '' : 's'}
        </div>
        <div style="font-size:36px;font-weight:800;letter-spacing:-1px;color:${grandTotal >= 0 ? 'var(--text)' : 'var(--coral)'}">
          ${bgFmt(grandTotal)}
        </div>
        <div style="font-size:12px;color:var(--text-2);margin-top:4px">
          Combined balance with interest · ${new Date().toLocaleDateString('en-GB', { day:'numeric', month:'long', year:'numeric' })}
        </div>
        <div style="display:flex;gap:12px;margin-top:14px">
          <div style="flex:1;background:var(--bg);border-radius:8px;padding:10px 12px">
            <div style="font-size:11px;color:var(--text-2);margin-bottom:2px">Net deposits</div>
            <div style="font-size:14px;font-weight:700">${bgFmt(grandPrincipal)}</div>
          </div>
          <div style="flex:1;background:var(--bg);border-radius:8px;padding:10px 12px">
            <div style="font-size:11px;color:var(--text-2);margin-bottom:2px">This year's interest</div>
            <div style="font-size:14px;font-weight:700;color:#43a047">+${bgFmt(grandThisYearInterest)}</div>
          </div>
          <div style="flex:1;background:var(--bg);border-radius:8px;padding:10px 12px">
            <div style="font-size:11px;color:var(--text-2);margin-bottom:2px">All time interest</div>
            <div style="font-size:14px;font-weight:700;color:#43a047">${grandInterest >= 0 ? '+' : ''}${bgFmt(grandInterest)}</div>
          </div>
        </div>
      </div>

      <!-- Combined balance over time chart -->
      ${hasChart ? `
      <div style="margin:0 12px 8px;background:var(--card);border-radius:var(--radius);padding:14px 12px">
        <div style="font-size:12px;font-weight:600;color:var(--text-2);letter-spacing:.4px;margin-bottom:10px">TOTAL IN THE BANK OVER TIME</div>
        <div style="position:relative;height:180px"><canvas id="bg-summary-chart"></canvas></div>
      </div>
      ` : ''}

      <!-- Per-account breakdown -->
      <div style="margin:0 12px 8px;background:var(--card);border-radius:var(--radius);overflow:hidden">
        <div style="font-size:11px;font-weight:600;color:var(--text-2);letter-spacing:.4px;padding:12px 14px 6px">ACCOUNTS</div>
        ${perHolding.map(p => `
          <div class="bg-holding-row" data-holding-id="${p.holding.id}" style="display:flex;align-items:center;gap:10px;padding:12px 14px;border-top:1px solid var(--border);cursor:pointer">
            <span style="font-size:18px">🏦</span>
            <div style="flex:1;min-width:0">
              <div style="font-weight:600;font-size:15px">${bgHoldingName(p.holding)}</div>
              <div style="font-size:11px;color:var(--text-2)">Net deposits ${bgFmt(p.principal)} · interest ${p.interest >= 0 ? '+' : ''}${bgFmt(p.interest)}</div>
            </div>
            <span style="font-weight:700;font-size:15px;color:${p.total >= 0 ? 'var(--text)' : 'var(--coral)'}">${bgFmt(p.total)}</span>
            <span class="settings-row-chevron">›</span>
          </div>
        `).join('')}
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
        </div>
      </div>
    </div>
  `;

  const screen = viewContainer.querySelector('#bg-screen');
  screen.querySelectorAll('[data-holding-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.holdingId;
      renderBankGilulu(val === 'summary' ? 'summary' : Number(val));
    });
  });
  screen.querySelector('#bg-add-account')?.addEventListener('click', () => openBgAccountEditor(null, () => renderBankGilulu()));
  screen.querySelector('#bg-rate-log-btn')?.addEventListener('click', () => {
    openBgRateLogEditor(() => renderBankGilulu('summary'));
  });

  const canvas = screen.querySelector('#bg-summary-chart');
  if (canvas && hasChart) {
    // Per-account palette for the overlaid lines; the combined total is drawn on
    // top as a thicker blue line.
    const palette = ['#e5533c', '#8e44ad', '#f39c12', '#16a085', '#c2185b', '#00838f', '#5d4037', '#7cb342'];
    const accountSeries = perHolding.map((p, i) => {
      const colour = palette[i % palette.length];
      return {
        label: bgHoldingName(p.holding),
        data: chartDates.map(d => bgTotalWithInterest(p.txs.filter(t => t.date <= d), ratePeriods, d)),
        borderColor: colour,
        backgroundColor: colour,
        fill: false,
        tension: 0.3,
        borderWidth: 1.5,
        pointRadius: 0,
        pointHoverRadius: 4,
      };
    });
    const totalSeries = {
      label: 'Total',
      data: chartValues,
      borderColor: '#1a73e8',
      backgroundColor: 'rgba(26,115,232,0.08)',
      fill: true,
      tension: 0.3,
      borderWidth: 2.5,
      pointRadius: chartDates.length > 20 ? 0 : 3,
      pointBackgroundColor: '#1a73e8',
    };
    // Only bother overlaying per-account lines when there's more than one account
    const datasets = accountSeries.length > 1 ? [totalSeries, ...accountSeries] : [totalSeries];
    const range = Math.max(...chartValues) - Math.min(...chartValues);
    const niceSteps = [10, 25, 50, 100, 250, 500, 1000, 2000, 5000];
    const step = niceSteps.find(s => range / s <= 7) ?? 10000;
    new Chart(canvas, {
      type: 'line',
      data: {
        labels: chartDates.map(d => new Date(d + 'T12:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' })),
        datasets,
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: datasets.length > 1, position: 'bottom', labels: { boxWidth: 10, boxHeight: 10, font: { size: 10 }, padding: 8, usePointStyle: true } },
          tooltip: { callbacks: { label: ctx => `${ctx.dataset.label}: £` + ctx.parsed.y.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) } },
        },
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
  const pendingCount = await getPendingSyncCount();
  let resumeNote = '';
  try {
    const cur = JSON.parse(await getSetting('uploadCursor') || 'null');
    if (cur) resumeNote = `<br><span style="color:#ea4335;font-weight:600">Incomplete – will resume at ${cur.table}</span>`;
  } catch {}
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
          <div class="settings-row" id="sync-now-btn">
            <span class="settings-row-icon">🔄</span>
            <span class="settings-row-label">Sync now</span>
            ${pendingCount > 0 ? `<span style="margin-left:auto;background:#ea4335;color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:10px">${pendingCount} pending</span>` : ''}
          </div>
          <div class="settings-row" id="force-upload-btn">
            <span class="settings-row-icon">⬆️</span>
            <div style="flex:1">
              <div class="settings-row-label">Force re-upload from this device</div>
              <div style="font-size:11px;color:var(--text-2);margin-top:1px">Overwrites cloud with this device's data. Only use on the device with the correct data.${resumeNote}</div>
            </div>
          </div>
          <div class="settings-row" id="force-download-btn">
            <span class="settings-row-icon">⬇️</span>
            <div style="flex:1">
              <div class="settings-row-label">Re-download everything from cloud</div>
              <div style="font-size:11px;color:var(--text-2);margin-top:1px">Full restore. Use on a device that is missing data – "Sync now" only fetches changes since the last sync.</div>
            </div>
          </div>
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
          <div class="settings-row" id="nav-bank-gilulu"><span class="settings-row-icon">🏦</span><span class="settings-row-label">Bank of Gilulu</span><span class="settings-row-chevron">›</span></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Costs</div>
        <div class="settings-card">
          <div class="settings-row" id="nav-recurring"><span class="settings-row-icon">🔄</span><span class="settings-row-label">Recurring expenses</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-distributions"><span class="settings-row-icon">📅</span><span class="settings-row-label">Big Expenses</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-household-bills"><span class="settings-row-icon">🏠</span><span class="settings-row-label">Household Bills (Rich)</span><span class="settings-row-chevron">›</span></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Savings</div>
        <div class="settings-card">
          <div class="settings-row" id="savings-target-row" style="cursor:pointer"><span class="settings-row-icon">💛</span><span class="settings-row-label">Savings targets</span><span style="color:var(--text-2);font-size:14px;margin-left:auto">${fmt(activeSavings)}/mo now</span><span class="settings-row-chevron">›</span></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Financial goals</div>
        <div class="settings-card">
          <div class="settings-row" id="nav-net-wealth"><span class="settings-row-icon">📊</span><span class="settings-row-label">Net wealth tracker</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-mortgage-free"><span class="settings-row-icon">🏡</span><span class="settings-row-label">Mortgage free</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-help-to-buy"><span class="settings-row-icon">🔑</span><span class="settings-row-label">Help to Buy</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-investments"><span class="settings-row-icon">📈</span><span class="settings-row-label">Investments</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-charity"><span class="settings-row-icon">💝</span><span class="settings-row-label">Charity donations</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="nav-pension"><span class="settings-row-icon">🏦</span><span class="settings-row-label">Pension maximising</span><span class="settings-row-chevron">›</span></div>
        </div>
      </div>
      <div class="settings-section">
        <div class="settings-section-title">Data</div>
        <div class="settings-card">
          <div class="settings-row" id="nav-import"><span class="settings-row-icon">📥</span><span class="settings-row-label">Import data</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="export-btn"><span class="settings-row-icon">📤</span><span class="settings-row-label">Export data (JSON)</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="diag-btn"><span class="settings-row-icon">🔍</span><span class="settings-row-label">Diagnostics</span><span class="settings-row-chevron">›</span></div>
          <div class="settings-row" id="clear-btn" style="color:var(--red)"><span class="settings-row-icon">🗑️</span><span class="settings-row-label" style="color:var(--red)">Clear all data</span></div>
        </div>
      </div>
      ${syncSection}
      <div style="text-align:center;padding:20px;color:var(--text-2);font-size:12px">App updated: 31 Jul 2026 at 14:29 BST (v57)</div>
    </div>
  `;
  viewContainer.querySelector('#savings-target-row').onclick = () => openSavingsSheet();
  viewContainer.querySelector('#nav-rec-income').onclick = () => navigate('recurring', { recurringTab: 'income' });
  viewContainer.querySelector('#nav-extra-incomes').onclick = () => navigate('extraIncomes');
  viewContainer.querySelector('#nav-recurring').onclick = () => navigate('recurring', { recurringTab: 'expenses' });
  viewContainer.querySelector('#nav-distributions').onclick = () => navigate('distributions');
  viewContainer.querySelector('#nav-household-bills').onclick = () => navigate('householdBills');
  viewContainer.querySelector('#nav-net-wealth').onclick = () => navigate('netWealth');
  viewContainer.querySelector('#nav-mortgage-free').onclick = () => navigate('mortgageFree');
  viewContainer.querySelector('#nav-help-to-buy').onclick = () => navigate('helpToBuy');
  viewContainer.querySelector('#nav-investments').onclick = () => navigate('investments');
  viewContainer.querySelector('#nav-charity').onclick = () => navigate('charity');
  viewContainer.querySelector('#nav-pension').onclick = () => navigate('pension');
  viewContainer.querySelector('#nav-bank-gilulu').onclick = () => navigate('bankGilulu');
  viewContainer.querySelector('#nav-import').onclick = () => navigate('import');
  viewContainer.querySelector('#export-btn').onclick = exportData;
  viewContainer.querySelector('#clear-btn').onclick = async () => {
    if (!confirm('This will delete ALL local data permanently. Are you sure?')) return;
    if (!confirm('Really? This cannot be undone.')) return;
    await Promise.all([db.transactions.clear(), db.distributions.clear(), db.accountSnapshots.clear(), db.friendTransactions.clear()]);
    // Reset the incremental watermark so the next sync performs a FULL pull.
    // Without this, "Sync now" only asks for documents newer than the last sync
    // and can never restore what was just cleared.
    await setSetting('lastSyncAt', 0);
    showToast('Data cleared – use "Re-download everything from cloud" to restore'); navigate('balance');
  };
  const signinBtn = viewContainer.querySelector('#google-signin-btn');
  if (signinBtn) signinBtn.onclick = async () => { try { await signInWithGoogle(); } catch (e) { showToast('Sign-in failed: ' + e.message); } };
  const syncNowBtn = viewContainer.querySelector('#sync-now-btn');
  if (syncNowBtn) syncNowBtn.onclick = async () => {
    showToast('Syncing…');
    const pushed = await flushSyncQueue();
    await pullFromFirestore();
    await regenerateAllDistributionChildren();
    showToast(pushed > 0 ? `Synced – pushed ${pushed} pending change${pushed === 1 ? '' : 's'}` : 'Sync complete');
    renderSettings();
  };
  const forceUploadBtn = viewContainer.querySelector('#force-upload-btn');
  if (forceUploadBtn) forceUploadBtn.onclick = async () => {
    if (!confirm('This will overwrite cloud data with everything on this device. Use this on the device that has the most complete data. Continue?')) return;
    if (!auth.currentUser) { showToast('Not signed in – please sign in first'); return; }
    const prog = showProgressOverlay('Uploading to cloud');
    try {
      const report = await uploadAllToFirestore((done, total, label) => {
        prog.update(done, total, label);
      });
      prog.close();
      showUploadReport(report, null);
    } catch (e) {
      prog.close();
      console.error('Force upload error:', e);
      showUploadReport(await getLastUploadReport(), e.message);
    }
    renderSettings();
  };
  const forceDownloadBtn = viewContainer.querySelector('#force-download-btn');
  if (forceDownloadBtn) forceDownloadBtn.onclick = async () => {
    if (!auth.currentUser) { showToast('Not signed in – please sign in first'); return; }
    if (!confirm('This replaces this device\'s data with everything stored in the cloud. Continue?')) return;
    const prog = showProgressOverlay('Downloading from cloud');
    try {
      const pulled = await downloadAllFromCloud();
      await regenerateAllDistributionChildren();
      prog.close();
      showToast(`Restored ${pulled} record${pulled === 1 ? '' : 's'} from cloud`);
    } catch (e) {
      prog.close();
      showToast('Download failed: ' + e.message);
      console.error('Force download error:', e);
    }
    renderSettings();
  };
  const diagBtn = viewContainer.querySelector('#diag-btn');
  if (diagBtn) diagBtn.onclick = async () => {
    const uid = auth.currentUser?.uid ?? 'Not signed in';
    const tableNames = ['transactions', 'categories', 'recurringIncome', 'recurringExpenses',
      'savingsTargets', 'distributions', 'accounts', 'accountSnapshots',
      'friendHoldings', 'friendTransactions', 'settings'];
    const counts = {};
    for (const t of tableNames) counts[t] = await db[t].count();
    const pending = await getPendingSyncCount();
    const overlay = document.createElement('div');
    overlay.className = 'sheet-overlay';
    const rowsHtml = cloud => Object.entries(counts).map(([t, n]) => {
      const c = cloud ? cloud[t] : null;
      const match = cloud && c === n;
      const cloudCell = cloud === null ? '<span style="color:var(--text-2)">–</span>'
        : `<span style="color:${match ? '#43a047' : '#ea4335'};font-weight:600">${c}</span>`;
      return `<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0">
        <span>${t}</span><span>${n} → ${cloudCell}</span></div>`;
    }).join('');
    overlay.innerHTML = `
      <div class="sheet">
        <div class="sheet-handle"></div>
        <div class="sheet-header"><span class="screen-title">Diagnostics</span></div>
        <div class="sheet-body" style="padding:16px">
          <div style="font-size:12px;font-family:monospace;background:var(--bg);padding:12px;border-radius:8px;margin-bottom:10px;word-break:break-all;line-height:1.7">
            <div><strong>Auth UID:</strong> ${uid}</div>
            <div style="margin-top:8px"><strong>local → cloud</strong></div>
            <div id="diag-rows">${rowsHtml(null)}</div>
            <div style="margin-top:8px"><strong>Sync queue pending:</strong> ${pending}</div>
            <div id="diag-ping" style="margin-top:8px"></div>
          </div>
          <button class="btn" id="diag-ping-btn" style="width:100%;margin-bottom:8px">Test cloud connection</button>
          <button class="btn" id="diag-cloud-btn" style="width:100%;margin-bottom:8px">Compare with cloud</button>
          <button class="btn btn-primary" id="diag-close" style="width:100%">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.onclick = e => { if (e.target === overlay) overlay.remove(); };
    overlay.querySelector('#diag-close').onclick = () => overlay.remove();
    overlay.querySelector('#diag-ping-btn').onclick = async () => {
      const out = overlay.querySelector('#diag-ping');
      out.innerHTML = 'Testing…';
      try {
        await pingFirestore();
        out.innerHTML = '<span style="color:#43a047;font-weight:600">✅ Write + read OK – auth, rules, network and quota all fine</span>';
      } catch (e) {
        out.innerHTML = `<span style="color:#ea4335;font-weight:600">❌ ${e.code || e.message}</span>`;
      }
    };
    overlay.querySelector('#diag-cloud-btn').onclick = async () => {
      const btn = overlay.querySelector('#diag-cloud-btn');
      btn.textContent = 'Counting…';
      try {
        const cloud = await getCloudCounts();
        overlay.querySelector('#diag-rows').innerHTML = rowsHtml(cloud);
        btn.textContent = 'Compare with cloud';
      } catch (e) {
        btn.textContent = 'Failed: ' + (e.code || e.message);
      }
    };
  };
  const signOutBtn = viewContainer.querySelector('#sign-out-btn');
  if (signOutBtn) signOutBtn.onclick = async () => { await signOutUser(); renderSettings(); };
}

function renderImport() {
  viewContainer.innerHTML = `
    <div class="import-screen">
      <div class="screen-header" style="padding-top:52px">
        <button class="icon-btn" onclick="window.app.goBack()"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="15 18 9 12 15 6"/></svg></button>
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
            // Fire Firestore writes without awaiting – offline persistence retries automatically
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

  if (ver < 9) {
    await setSetting('dataVersion', 9);
    // Unarchive "Sale" so it's selectable for income logging
    await db.categories.update(20, { isArchived: false, sortOrder: 16 });
    queueWrite('categories', 20).catch(() => {});
    // Add "Gift" income category
    const existingGift = await db.categories.get(29);
    if (!existingGift) {
      await db.categories.add({ id: 29, name: 'Gift', icon: '🎁', colour: '#4CAF50', isIncome: true, sortOrder: 17, isArchived: false });
      queueWrite('categories', 29).catch(() => {});
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
  // Restore any missing big-expense daily entries before the first render, so
  // the balance is correct even offline / before sync runs.
  await ensureDistributionChildren();
  await handleRedirectResult();
  navBtns.forEach(btn => btn.addEventListener('click', () => navigate(btn.dataset.view)));
  initSync(user => {
    state.currentUser = user;
    if (state.view === 'settings') renderSettings();
  }, regenerateAllDistributionChildren);
  onSync(() => {
    if (state.view === 'settings') renderSettings();
  });
  navigate('balance');
}

window.app = { navigate, goBack };
init().catch(console.error);

// Swipe-right-from-the-left-edge acts as "back" on any page that has a top-left
// back button. Mirrors the native iOS/Android back gesture. We only trigger on
// a swipe that starts near the left edge, travels mostly horizontally, and ends
// well to the right — so it never fights vertical scrolling or in-page swipes
// (e.g. swipe-to-delete rows, which start away from the edge).
(function enableSwipeBack() {
  const EDGE = 32;      // px from the left edge the gesture must start within
  const MIN_X = 70;     // px of rightward travel required
  const MAX_Y = 60;     // max vertical drift allowed
  // Views that show a back button and should respond to the gesture.
  const BACKABLE = new Set([
    'breakdown', 'recurring', 'extraIncomes', 'distributions', 'netWealth',
    'mortgageFree', 'helpToBuy', 'investments', 'charity', 'pension',
    'bankGilulu', 'householdBills', 'accounts', 'yearlyTrends', 'import',
  ]);
  let startX = 0, startY = 0, tracking = false;
  viewContainer.addEventListener('touchstart', e => {
    // Ignore if a sheet/overlay is open (those have their own dismissal).
    if (document.querySelector('.sheet-overlay')) { tracking = false; return; }
    const t = e.touches[0];
    tracking = t.clientX <= EDGE && BACKABLE.has(state.view);
    startX = t.clientX; startY = t.clientY;
  }, { passive: true });
  viewContainer.addEventListener('touchend', e => {
    if (!tracking) return;
    tracking = false;
    const t = e.changedTouches[0];
    const dx = t.clientX - startX, dy = Math.abs(t.clientY - startY);
    if (dx >= MIN_X && dy <= MAX_Y) goBack();
  }, { passive: true });
})();
