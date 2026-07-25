// Budget calculation engine

import { db, getSetting } from './db.js';
import { today, isoDate, addDays, diffDays, daysInMonth, cycleForDate, monthlyEquivalent } from './utils.js';

export async function getCurrentCycle() {
  const startDay = (await getSetting('cycleStartDay')) ?? 1;
  return cycleForDate(today(), startDay);
}

export async function getCycleForDate(dateStr) {
  const startDay = (await getSetting('cycleStartDay')) ?? 1;
  return cycleForDate(dateStr, startDay);
}

export async function getCycleRecurringIncome(cycleStart, cycleEnd) {
  const rows = await db.recurringIncome
    .where('startDate').belowOrEqual(cycleEnd)
    .toArray();
  return rows
    .filter(r => r.isActive && (r.endDate == null || r.endDate === '4001-01-01' || r.endDate >= cycleStart))
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);
}

export async function getCycleRecurringExpenses(cycleStart, cycleEnd) {
  const rows = await db.recurringExpenses
    .where('startDate').belowOrEqual(cycleEnd)
    .toArray();
  return rows
    .filter(r => r.isActive && (r.endDate == null || r.endDate === '4001-01-01' || r.endDate >= cycleStart))
    .reduce((sum, r) => sum + monthlyEquivalent(r.amount ?? 0, r.frequency ?? 'monthly'), 0);
}

export async function getSavingsTarget() {
  const override = await getSetting('savingsAmount');
  if (override != null) return Number(override);

  const now = today();
  const targets = await db.savingsTargets
    .filter(t => t.startDate <= now && (t.endDate == null || t.endDate >= now || t.endDate === '4001-01-01'))
    .toArray();
  if (!targets.length) return 0;
  targets.sort((a, b) => b.startDate.localeCompare(a.startDate));
  return targets[0].amount ?? 0;
}

export async function calcDailyAllowance(cycleStart, cycleEnd) {
  const cycleLen = diffDays(cycleStart, cycleEnd) + 1;
  const monthlyIncome    = await getCycleRecurringIncome(cycleStart, cycleEnd);
  const monthlyExpenses  = await getCycleRecurringExpenses(cycleStart, cycleEnd);
  const monthlySavings   = await getSavingsTarget();
  const available = monthlyIncome - monthlyExpenses - monthlySavings;
  const dailyAllowance = available / cycleLen;
  return { dailyAllowance, monthlyIncome, monthlyExpenses, monthlySavings, available, cycleLen };
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
  const { dailyAllowance, monthlyIncome, monthlyExpenses, monthlySavings } = await calcDailyAllowance(cycleStart, cycleEnd);

  const txns = await getVariableTransactions(cycleStart, cycleEnd);
  let variableExpenses = 0;
  let variableIncome = 0;
  let distributionExpenses = 0;
  for (const t of txns) {
    if (t.type === 'distributed_expense') distributionExpenses += Math.abs(t.amount);
    else if (t.type === 'expense') variableExpenses += Math.abs(t.amount);
    else if (t.type === 'income' || t.type === 'distributed_income') variableIncome += t.amount;
  }

  const cycleLen = diffDays(cycleStart, cycleEnd) + 1;
  const totalRecurringExpenses = monthlyExpenses * cycleLen / 30;
  const totalIncome = monthlyIncome + variableIncome;
  const totalExpenses = totalRecurringExpenses + variableExpenses + distributionExpenses;
  const budgetSpent = totalRecurringExpenses + monthlySavings * cycleLen / 30;
  const budgetLeft = totalIncome - totalExpenses - monthlySavings * cycleLen / 30;

  return {
    totalIncome, regularIncome: monthlyIncome, variableIncome,
    totalExpenses, recurringExpenses: totalRecurringExpenses, variableExpenses, distributionExpenses,
    savings: monthlySavings * cycleLen / 30,
    budgetLeft,
    dailyAllowance,
  };
}
