// Formatting and utility helpers

export function fmt(amount, showSign = false) {
  const abs = Math.abs(amount);
  const str = abs.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const sign = amount < 0 ? '-' : (showSign && amount > 0 ? '+' : '');
  return `${sign}£${str}`;
}

export function fmtCompact(amount) {
  const abs = Math.abs(amount);
  let str;
  if (abs >= 1000) {
    str = (abs / 1000).toFixed(1) + 'k';
  } else {
    str = abs.toFixed(2);
  }
  const sign = amount < 0 ? '-' : '';
  return `${sign}£${str}`;
}

export function fmtDate(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateLong(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtDateShort(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function dayName(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString('en-GB', { weekday: 'short' });
}

export function today() {
  return isoDate(new Date());
}

export function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + n);
  return isoDate(date);
}

export function diffDays(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round((b - a) / 86400000);
}

export function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

export function cycleForDate(dateStr, startDay = 1) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let cycleYear = y, cycleMonth = m;
  if (d < startDay) {
    cycleMonth--;
    if (cycleMonth < 1) { cycleMonth = 12; cycleYear--; }
  }
  const startStr = `${cycleYear}-${String(cycleMonth).padStart(2,'0')}-${String(startDay).padStart(2,'0')}`;
  const nextMonth = cycleMonth === 12 ? 1 : cycleMonth + 1;
  const nextYear = cycleMonth === 12 ? cycleYear + 1 : cycleYear;
  const endStr = addDays(`${nextYear}-${String(nextMonth).padStart(2,'0')}-${String(startDay).padStart(2,'0')}`, -1);
  return { start: startStr, end: endStr };
}

export function monthlyEquivalent(amount, frequency) {
  switch (frequency) {
    case 'monthly':   return amount;
    case 'yearly':    return amount / 12;
    case 'quarterly': return amount / 3;
    case 'weekly':    return amount * 52 / 12;
    default:          return amount;
  }
}

export function dailyEquivalent(amount, frequency, daysInCycle = 30) {
  switch (frequency ?? 'monthly') {
    case 'yearly':    return amount / 365;
    case 'weekly':    return amount / 7;
    default:          return monthlyEquivalent(amount, frequency) / daysInCycle;
  }
}

export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') e.className = v;
    else if (k === 'textContent') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  }
  for (const child of children) {
    if (typeof child === 'string') e.appendChild(document.createTextNode(child));
    else if (child) e.appendChild(child);
  }
  return e;
}

export function html(strings, ...vals) {
  return strings.reduce((acc, str, i) => acc + str + (vals[i] ?? ''), '');
}

export function qs(sel, ctx = document) { return ctx.querySelector(sel); }
export function qsa(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

export function on(target, event, handler) {
  target.addEventListener(event, handler);
  return () => target.removeEventListener(event, handler);
}

export function delegate(target, event, sel, handler) {
  target.addEventListener(event, e => {
    const found = e.target.closest(sel);
    if (found) handler(e, found);
  });
}
