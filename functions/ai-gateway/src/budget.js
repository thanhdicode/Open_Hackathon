/**
 * Spend guard for paid rescue providers.
 *
 * The free lanes are tried first and only their failure escalates to a paid
 * model, so credits are spent on a demo-critical request that would otherwise
 * fail — never on routine traffic and never during soak tests.
 *
 * State is per function instance and in-memory. It bounds a single session's
 * spend; it is not an account-level ledger. Treat it as a fuse, not accounting.
 */

const FREE_ONLY = () => process.env.EXPLABS_FREE_ONLY !== "false";
const PAID_RESCUE = () => process.env.EXPLABS_PAID_RESCUE !== "false";
const SESSION_BUDGET_USD = () => Number(process.env.EXPLABS_SESSION_BUDGET_USD || 0.1);
const DEMO_BUDGET_USD = () => Number(process.env.EXPLABS_DEMO_BUDGET_USD || 1.0);

const state = {
  sessionSpentUsd: 0,
  totalSpentUsd: 0,
  /** Calls that reported a cost, including free ones that reported 0. */
  costedCalls: 0,
  /** Calls that actually cost money. */
  paidCalls: 0,
  refused: 0,
  startedAt: new Date().toISOString(),
  lastCostUsd: null,
};

/**
 * May a paid call proceed right now?
 *
 * Returns a reason when refused so the caller can fall through to the next
 * provider instead of failing the user's request.
 */
export function maySpendPaid(estimatedUsd = 0) {
  const sessionBudgetUsd = SESSION_BUDGET_USD();
  const remainingUsd = Math.max(0, Math.min(SESSION_BUDGET_USD() - state.sessionSpentUsd, DEMO_BUDGET_USD() - state.totalSpentUsd));

  if (FREE_ONLY()) {
    return { allowed: false, reason: "free-only mode", sessionSpentUsd: state.sessionSpentUsd, sessionBudgetUsd, remainingUsd };
  }
  if (!PAID_RESCUE()) {
    return { allowed: false, reason: "paid rescue disabled", sessionSpentUsd: state.sessionSpentUsd, sessionBudgetUsd, remainingUsd };
  }
  if (remainingUsd <= 0) {
    return { allowed: false, reason: "budget exhausted", sessionSpentUsd: state.sessionSpentUsd, sessionBudgetUsd, remainingUsd };
  }
  if (estimatedUsd > remainingUsd) {
    return { allowed: false, reason: "estimated cost exceeds remaining budget", sessionSpentUsd: state.sessionSpentUsd, sessionBudgetUsd, remainingUsd };
  }
  return { allowed: true, sessionSpentUsd: state.sessionSpentUsd, sessionBudgetUsd, remainingUsd };
}

/** Record the cost a provider reported in its own response. */
export function recordCost(usd) {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return;
  state.sessionSpentUsd += usd;
  state.totalSpentUsd += usd;
  state.costedCalls += 1;
  if (usd > 0) state.paidCalls += 1;
  state.lastCostUsd = usd;
}

export function recordRefusal() {
  state.refused += 1;
}

export function budgetSnapshot() {
  return {
    mode: FREE_ONLY() ? "free-only" : PAID_RESCUE() ? "paid-rescue-enabled" : "paid-disabled",
    sessionSpentUsd: Number(state.sessionSpentUsd.toFixed(6)),
    totalSpentUsd: Number(state.totalSpentUsd.toFixed(6)),
    sessionBudgetUsd: SESSION_BUDGET_USD(),
    demoBudgetUsd: DEMO_BUDGET_USD(),
    remainingUsd: Number(Math.max(0, Math.min(SESSION_BUDGET_USD() - state.sessionSpentUsd, DEMO_BUDGET_USD() - state.totalSpentUsd)).toFixed(6)),
    costedCalls: state.costedCalls,
    paidCalls: state.paidCalls,
    refusals: state.refused,
    lastCostUsd: state.lastCostUsd,
    startedAt: state.startedAt,
  };
}

export function resetBudget() {
  state.sessionSpentUsd = 0;
  state.totalSpentUsd = 0;
  state.costedCalls = 0;
  state.paidCalls = 0;
  state.refused = 0;
  state.lastCostUsd = null;
}
