import { type Money, assertMoney, sum } from "./money.js";

export interface Balance {
  playerId: string;
  /** Positive: is owed money. Negative: owes money. */
  amount: Money;
}

export interface Transfer {
  from: string;
  to: string;
  amount: Money;
}

/** Above this many non-zero balances the exact search is too slow; fall back to greedy. */
const EXACT_LIMIT = 20;

/**
 * Settle balances with the minimum number of transfers.
 *
 * The minimum equals (number of non-zero balances) − (max number of disjoint zero-sum
 * groups they can be split into). We find that partition exactly with a bitmask DP for
 * up to 20 players, then settle each group greedily (k players → k−1 transfers).
 * Output is deterministic for the same input.
 */
export function settle(balances: readonly Balance[]): Transfer[] {
  const merged = new Map<string, Money>();
  for (const b of balances) {
    assertMoney(b.amount, `balance of ${b.playerId}`);
    merged.set(b.playerId, (merged.get(b.playerId) ?? 0) + b.amount);
  }
  const nonZero = [...merged.entries()]
    .filter(([, a]) => a !== 0)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([playerId, amount]) => ({ playerId, amount }));

  if (sum(nonZero.map((b) => b.amount)) !== 0) {
    throw new Error("balances do not sum to zero");
  }
  if (nonZero.length === 0) return [];

  const groups = nonZero.length <= EXACT_LIMIT ? zeroSumPartition(nonZero) : [nonZero];
  return groups.flatMap(greedy);
}

function zeroSumPartition(items: Balance[]): Balance[][] {
  const n = items.length;
  const size = 1 << n;
  const subsetSum = new Float64Array(size);
  // best[mask]: along the best chain of single-element removals from `mask` down to ∅,
  // how many masks are zero-sum. Consecutive zero-sum masks on the chain differ by a
  // zero-sum group, so best[full] is the maximum number of zero-sum groups.
  const best = new Int8Array(size);
  const prevOf = new Int32Array(size);
  for (let mask = 1; mask < size; mask++) {
    const low = mask & -mask;
    subsetSum[mask] = subsetSum[mask ^ low]! + items[31 - Math.clz32(low)]!.amount;
    let bestVal = -1;
    let bestPrev = 0;
    for (let rest = mask; rest; rest &= rest - 1) {
      const prev = mask ^ (rest & -rest);
      if (best[prev]! > bestVal) {
        bestVal = best[prev]!;
        bestPrev = prev;
      }
    }
    best[mask] = bestVal + (subsetSum[mask] === 0 ? 1 : 0);
    prevOf[mask] = bestPrev;
  }
  const groups: Balance[][] = [];
  let boundary = size - 1;
  for (let mask = size - 1; mask; ) {
    const prev = prevOf[mask]!;
    if (prev === 0 || subsetSum[prev] === 0) {
      groups.push(maskItems(items, boundary ^ prev));
      boundary = prev;
    }
    mask = prev;
  }
  return groups.reverse();
}

function maskItems(items: Balance[], mask: number): Balance[] {
  return items.filter((_, i) => mask & (1 << i));
}

function greedy(group: Balance[]): Transfer[] {
  const debtors = group.filter((b) => b.amount < 0).map((b) => ({ ...b, amount: -b.amount }));
  const creditors = group.filter((b) => b.amount > 0).map((b) => ({ ...b }));
  debtors.sort((a, b) => b.amount - a.amount || cmp(a.playerId, b.playerId));
  creditors.sort((a, b) => b.amount - a.amount || cmp(a.playerId, b.playerId));
  const out: Transfer[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const debtor = debtors[d]!;
    const creditor = creditors[c]!;
    const amount = Math.min(debtor.amount, creditor.amount);
    out.push({ from: debtor.playerId, to: creditor.playerId, amount });
    debtor.amount -= amount;
    creditor.amount -= amount;
    if (debtor.amount === 0) d++;
    if (creditor.amount === 0) c++;
  }
  return out;
}

function cmp(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Open debts from earlier games carry into the next settlement and are netted there.
 * A debt "A owes B 100" becomes balance −100 for A and +100 for B.
 */
export function balancesWithOpenDebts(
  gameNet: readonly Balance[],
  openDebts: readonly Transfer[],
): Balance[] {
  const out: Balance[] = gameNet.map((b) => ({ ...b }));
  for (const debt of openDebts) {
    out.push({ playerId: debt.from, amount: -debt.amount });
    out.push({ playerId: debt.to, amount: debt.amount });
  }
  return out;
}
