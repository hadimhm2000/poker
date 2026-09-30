/**
 * Good-payer index: how many days, on average, a player takes from the close of a game to
 * the moment their debt from it is marked paid. Only settled debts count (paid, or netted
 * against a debt in another home); carried debts moved into a later game and are not a
 * payment. Shown only inside the home, and only when the host turned it on.
 */

export interface PaidDebt {
  playerId: string;
  name: string;
  closedAt: Date;
  paidAt: Date;
}

export interface PayerScore {
  playerId: string;
  name: string;
  /** Average days from close to paid, one decimal; null while nothing was paid yet. */
  averageDays: number | null;
  /** Debts counted. */
  debts: number;
  /** Debts still open (not counted in the average). */
  open: number;
}

const DAY = 86_400_000;

export function payerIndex(paid: readonly PaidDebt[], open: readonly { playerId: string; name: string }[] = []): PayerScore[] {
  const acc = new Map<string, { name: string; days: number; debts: number; open: number }>();
  const get = (id: string, name: string) => {
    let a = acc.get(id);
    if (!a) acc.set(id, (a = { name, days: 0, debts: 0, open: 0 }));
    return a;
  };
  for (const d of paid) {
    const a = get(d.playerId, d.name);
    a.days += Math.max(0, d.paidAt.getTime() - d.closedAt.getTime()) / DAY;
    a.debts++;
  }
  for (const d of open) get(d.playerId, d.name).open++;
  return [...acc.entries()]
    .map(([playerId, a]) => ({
      playerId,
      name: a.name,
      averageDays: a.debts ? Math.round((a.days / a.debts) * 10) / 10 : null,
      debts: a.debts,
      open: a.open,
    }))
    .sort(
      (x, y) =>
        (x.averageDays === null ? 1 : 0) - (y.averageDays === null ? 1 : 0) ||
        (x.averageDays ?? 0) - (y.averageDays ?? 0) ||
        x.open - y.open ||
        x.name.localeCompare(y.name),
    );
}
