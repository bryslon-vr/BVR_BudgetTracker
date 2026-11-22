// Helpers for months written as YYYY-MM (the format stored in the budgets table)

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const isMonth = (value) => typeof value === 'string' && MONTH.test(value);

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

// shiftMonth('2026-12', 1) gives '2027-01'; shiftMonth('2026-01', -1) gives '2025-12'
function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// monthLabel('2026-11') gives 'November 2026'
function monthLabel(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

// lastMonths('2026-11', 3) gives ['2026-09', '2026-10', '2026-11'] (oldest first)
function lastMonths(endMonth, count) {
  const months = [];
  for (let i = count - 1; i >= 0; i--) months.push(shiftMonth(endMonth, -i));
  return months;
}

// shortMonth('2026-11') gives 'Nov'
function shortMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'short' });
}

module.exports = { isMonth, currentMonth, shiftMonth, monthLabel, lastMonths, shortMonth };