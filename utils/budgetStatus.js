// The rules for budget warnings, kept in one place so every page agrees.
// Money is compared in whole cents so 0.1 + 0.2 style rounding errors can never change a result.

const toCents = (n) => Math.round((Number(n) || 0) * 100);

// 'none'      no budget (or a limit of 0): nothing to warn about
// 'ok'        under 80% of the limit
// 'warning'   80% or more, but not over the limit
// 'exceeded'  100% or more of the limit
function budgetStatus(spent, limit) {
  const limitCents = toCents(limit);
  if (limitCents <= 0) return 'none';
  const spentCents = toCents(spent);
  if (spentCents >= limitCents) return 'exceeded';
  if (spentCents * 5 >= limitCents * 4) return 'warning'; // spent / limit >= 0.8
  return 'ok';
}

// Whole percent used (85.5% gives 85), or 0 when there is no limit
function budgetPercent(spent, limit) {
  const limitCents = toCents(limit);
  if (limitCents <= 0) return 0;
  return Math.floor((toCents(spent) * 100) / limitCents);
}

// From a list of budgets that each have a status and percent: the ones that need attention,
// worst first (over budget before almost at the limit, then highest percent first)
function budgetAlerts(budgets) {
  return budgets
    .filter((b) => b.status === 'warning' || b.status === 'exceeded')
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'exceeded' ? -1 : 1;
      return b.percent - a.percent;
    });
}

module.exports = { budgetStatus, budgetPercent, budgetAlerts };