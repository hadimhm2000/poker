"use client";

import { type Pot, awardPots, buildPots } from "@poker/domain";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { normalizeDigits } from "@/lib/format";

interface Row {
  key: number;
  name: string;
  amount: string;
  folded: boolean;
}

const EXAMPLE: Row[] = [
  { key: 1, name: "A", amount: "100", folded: false },
  { key: 2, name: "B", amount: "300", folded: false },
  { key: 3, name: "C", amount: "500", folded: false },
  { key: 4, name: "D", amount: "500", folded: false },
  { key: 5, name: "E", amount: "50", folded: true },
];

export function SidePotCalculator() {
  const t = useTranslations("sidepot");
  const [rows, setRows] = useState<Row[]>(EXAMPLE);
  const [button, setButton] = useState(1);
  const [winners, setWinners] = useState<Record<number, number[]>>({});
  const locale = useLocale();
  const fmt = new Intl.NumberFormat(locale);

  const result = useMemo(() => {
    try {
      const players = rows.map((r) => ({
        id: String(r.key),
        contributed: Number(normalizeDigits(r.amount || "0")),
        folded: r.folded,
      }));
      if (players.some((p) => !Number.isSafeInteger(p.contributed) || p.contributed < 0)) return null;
      const pots = buildPots(players);
      let payouts: Map<string, number> | null = null;
      const chosen = pots.map((p) => (p.uncalled ? p.eligible : (winners[p.index] ?? []).map(String).filter((id) => p.eligible.includes(id))));
      if (chosen.every((w) => w.length > 0)) {
        const seatOrder = rows.map((r) => String(r.key));
        const btn = seatOrder.includes(String(button)) ? String(button) : seatOrder[0]!;
        payouts = new Map(awardPots(pots, chosen, { seatOrder, button: btn }).map((p) => [p.playerId, p.amount]));
      }
      return { pots, payouts, total: players.reduce((a, p) => a + p.contributed, 0) };
    } catch {
      return null;
    }
  }, [rows, winners, button]);

  const nameOf = (id: string) => rows.find((r) => String(r.key) === id)?.name || "?";
  const update = (key: number, patch: Partial<Row>) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    setWinners({});
  };
  const toggleWinner = (pot: Pot, key: number) =>
    setWinners((w) => {
      const cur = w[pot.index] ?? [];
      return { ...w, [pot.index]: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] };
    });

  return (
    <div className="stack">
      <section className="card table-wrap">
        <table>
          <thead>
            <tr>
              <th>{t("button")}</th>
              <th>{t("player")}</th>
              <th>{t("contributed")}</th>
              <th>{t("folded")}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>
                  <input type="radio" name="button" checked={button === r.key} onChange={() => setButton(r.key)} aria-label={t("button")} />
                </td>
                <td>
                  <input value={r.name} maxLength={20} onChange={(e) => update(r.key, { name: e.target.value })} aria-label={t("player")} />
                </td>
                <td>
                  <input value={r.amount} inputMode="numeric" dir="ltr" onChange={(e) => update(r.key, { amount: e.target.value })} aria-label={t("contributed")} />
                </td>
                <td>
                  <input type="checkbox" checked={r.folded} onChange={(e) => update(r.key, { folded: e.target.checked })} aria-label={t("folded")} />
                </td>
                <td>
                  <button className="linklike" type="button" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={t("remove")}>
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <button
          className="btn secondary small"
          type="button"
          style={{ marginBlockStart: 10 }}
          onClick={() => {
            const key = Math.max(0, ...rows.map((r) => r.key)) + 1;
            setRows((rs) => [...rs, { key, name: String.fromCharCode(64 + key), amount: "", folded: false }]);
          }}
        >
          {t("addRow")}
        </button>
      </section>

      {!result ? (
        <div className="alert">{t("invalid")}</div>
      ) : (
        <section className="card table-wrap">
          <p className="muted small">
            {t("total", { amount: fmt.format(result.total) })} · {t("chooseWinners")}
          </p>
          <table>
            <thead>
              <tr>
                <th>{t("pot")}</th>
                <th className="end">{t("amount")}</th>
                <th>{t("eligible")}</th>
              </tr>
            </thead>
            <tbody>
              {result.pots.map((p) => (
                <tr key={p.index}>
                  <td>{p.index === 0 ? t("main") : t("side", { n: p.index })}</td>
                  <td className="end num">{fmt.format(p.amount)}</td>
                  <td>
                    {p.uncalled ? (
                      <span className="muted">{t("returned", { name: nameOf(p.eligible[0]!) })}</span>
                    ) : (
                      <span className="row" style={{ gap: 6 }}>
                        {p.eligible.map((id) => {
                          const on = (winners[p.index] ?? []).includes(Number(id));
                          return (
                            <button
                              key={id}
                              type="button"
                              className={`btn small ${on ? "" : "secondary"}`}
                              aria-pressed={on}
                              onClick={() => toggleWinner(p, Number(id))}
                            >
                              {nameOf(id)}
                            </button>
                          );
                        })}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.payouts && (
            <>
              <h3 style={{ marginBlockStart: 16 }}>{t("payouts")}</h3>
              <table>
                <tbody>
                  {rows.map((r) => {
                    const got = result.payouts!.get(String(r.key)) ?? 0;
                    const net = got - Number(normalizeDigits(r.amount || "0"));
                    return (
                      <tr key={r.key}>
                        <td>{r.name}</td>
                        <td className="end num">{fmt.format(got)}</td>
                        <td className={`end num ${net > 0 ? "win" : net < 0 ? "loss" : ""}`}>
                          {new Intl.NumberFormat(locale, { signDisplay: "exceptZero" }).format(net)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </>
          )}
        </section>
      )}
    </div>
  );
}
