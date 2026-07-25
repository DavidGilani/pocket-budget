// Budget calculation engine

import { db, getSetting } from './db.js';
import { today, isoDate, addDays, diffDays, daysInMonth, cycleForDate, monthlyEquivalent, dailyEquivalent } from './utils.js';

export async function getCurrentCycle() {
  const startDay = (await getSetting('cycleStartDay')) ?? 1;
  return cycleForDate(today(), startDay);
}

export async function getCycleForDate(dateStr) {
  const startDay = (await getSetting('cycleStartDay')) ?? 1;
  return cycleForDate(dateStr, startDay);
}

function inCycle(r, cycleStart, cycleEnd) {
  return r.startDate <= cycleEnd && (r.endDate == null || r.endDate === '4001-01-01' || r.endDate >= cycleStart);
}

// Days the item actually overlaps with the cycle (for pro-rata partial-month items)
function overlapDays(r, cycleStart, cycleEnd) {
  const effStart = r.startDate > cycleStart ? r.startDate : cycleStart;
  const effEnd = (!r.endDate || r.endDate === '4001-01-01' || r.endDate > cycleEnd) ? cycleEnd : r.endDate;
  return Math.max(0, diffDays(effStart, effEnd) + 1);
}

// Pro-rated daily contribution: full daily rate × (active days / cycle days)
function proratedDaily(r, cycleStart, cycleEnd, cycleLen) {
  const overlap = overlapDays(r, cycleStart, cycleEnd);
  return dailyEquivalent(r.amount ?? 0, r.frequency ?? 'monthly', cycleLen) * overlap / cycleLen;
}

export async function getCycleRecurringIncome(cycleStart, cycleEnd) {
  const cycleLen = diffDays(cycleStart, cycleEnd) + 1;
  const rows = await db.recurringIncome.where('startDate').belowOrEqual(cycleEnd).toArray();
  return rows.filter(r => inCycle(r, cycleStart, cycleEnd))
    .reduce((sum, r) => sum + proratedDaily(r, cycleStart, cycleEnd, cycleLen) * cycleLen, 0);
}

export async function getCycleRecurringExpenses(cycleStart, cycleEnd) {
  const cycleLen = diffDays(cycleStart, cycleEnd) + 1;
  const rows = await db.recurringExpenses.where('startDate').belowOrEqual(cycleEnd).toArray();
  return rows.filter(r => inCycle(r, cycleStart, cycleEnd))
    .reduce((sum, r) => sum + proratedDaily(r, cycleStart, cycleEnd, cycleLen) * cycleLen, 0);
}

export async function getSavingsTarget(forDate) {
  const d = forDate ?? today();
  const targets = await db.savingsTargets
    .filter(t => t.startDate <= d && (t.endDate == null || t.endDate >= d || t.endDate === '4001-01-01'))
    .toArray();
  if (!targets.length) return 0;
  targets.sort((a, b) => b.startDate.localeCompare(a.startDate));
  return targets[0].amount ?? 0;
}

export async function calcDailyAllowance(cycleStart, cycleEnd) {
  const cycleLen = diffDays(cycleStart, cycleEnd) + 1;
  const monthlyIncome   = await getCycleRecurringIncome(cycleStart, cycleEnd);
  const monthlyExpenses = await getCycleRecurringExpenses(cycleStart, cycleEnd);
  const monthlySavings  = await getSavingsTarget(cycleStart);
  const available = monthlyIncome - monthlyExpenses - monthlySavings;

  // Pro-rated daily: items active only part of the cycle contribute proportionally
  const expRows = await db.recurringExpenses.where('startDate').belowOrEqual(cycleEnd).toArray();
  const dailyExpenses = expRows
    .filter(r => inCycle(r, cycleStart, cycleEnd))
    .reduce((s, r) => s + proratedDaily(r, cycleStart, cycleEnd, cycleLen), 0);

  const dailyAllowance = monthlyIncome / cycleLen - dailyExpenses - monthlySavings / cycleLen;
  return { dailyAllowance, monthlyIncome, monthlyExpenses, monthlySavings, available, cycleLen, dailyExpenses };
}

export async function getVariableTransactions(fromDate, toDate) {
  return db.transactions
    .where('date').between(fromDate, toDate, true, true)
    .filter(t => t.type === 'expense' || t.type === 'income' || t.type === 'distributed_expense' || t.type === 'distributed_income')
    .toArray();
}

export async function calcRollingBalance(targetDate) {
  const cycle = await getCycleForDate(targetDate);
  const { dailyAllowance, monthlyIncome, monthlyExpenses, monthlySavings, available, cycleLen } = await calcDailyAllowance(cycle.start, cycle.end);

  const daysElapsed = diffDays(cycle.start, targetDate) + 1;
  const budgetAccrued = dailyAllowance * daysElapsed;

  const txns = await getVariableTransactions(cycle.start, targetDate);
  let variableExpenses = 0;
  let variableIncome = 0;
  for (const t of txns) {
    if (t.amount < 0) variableExpenses += Math.abs(t.amount);
    else variableIncome += t.amount;
  }

  const balance = budgetAccrued - variableExpenses + variableIncome;

  return {
    balance,
    dailyAllowance,
    budgetAccrued,
    variableExpenses,
    variableIncome,
    cycle,
    daysElapsed,
    cycleLen,
    monthlyIncome,
    monthlyExpenses,
    monthlySavings,
    available,
  };
}

export async function calcProjectedBalances(days = 3) {
  const base = today();
  const results = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(base, i);
    const { balance } = await calcRollingBalance(d);
    results.push({ date: d, balance });
  }
  return results;
}

export function generateDistributionChildren(dist) {
  const children = [];
  let d = dist.startDate;
  const total = dist.totalAmount;
  let dayCount = diffDays(dist.startDate, dist.endDate) + 1;
  if (dayCount < 1) dayCount = 1;
  const daily = total / dayCount;

  while (d <= dist.endDate) {
    children.push({
      date: d,
      amount: dist.isIncome ? daily : -daily,
      categoryId: dist.categoryId,
      note: dist.description,
      type: dist.isIncome ? 'distributed_income' : 'distributed_expense',
      distributionId: dist.id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      syncStatus: 'pending',
    });
    d = addDays(d, 1);
  }
  return children;
}

export async function getCycleBreakdown(cycleStart, cycleEnd) {
  const { dailyAllowance, monthlyIncome, monthlyExpenses, monthlySavings, cycleLen, dailyExpenses } = await calcDailyAllowance(cycleStart, cycleEnd);

  const txns = await getVariableTransactions(cycleStart, cycleEnd);
  let variableExpenses = 0;
  let variableIncome = 0;
  let distributionExpenses = 0;
  for (const t of txns) {
    if (t.type === 'distributed_expense') distributionExpenses += Math.abs(t.amount);
    else if (t.type === 'expense') variableExpenses += Math.abs(t.amount);
    else if (t.type === 'income' || t.type === 'distributed_income') variableIncome += t.amount;
  }

  // Use dailyExpenses*cycleLen so this matches calcRollingBalance (e.g. yearly uses amount/365*cycleLen)
  const totalRecurringExpenses = dailyExpenses * cycleLen;
  const totalIncome = monthlyIncome + variableIncome;
  const totalExpenses = totalRecurringExpenses + variableExpenses + distributionExpenses;
  const budgetLeft = totalIncome - totalExpenses - monthlySavings;

  return {
    totalIncome, regularIncome: monthlyIncome, variableIncome,
    totalExpenses, recurringExpenses: totalRecurringExpenses, variableExpenses, distributionExpenses,
    savings: monthlySavings,
    budgetLeft,
    dailyAllowance,
  };
}
