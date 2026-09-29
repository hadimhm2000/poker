"use client";

import { type ShowdownResult, type Variant, parseCards, showdown } from "@poker/domain";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { PlayingCard } from "./Card";

export function Showdown() {
  const t = useTranslations("showdown");
  const th = useTranslations("hand");
  const [variant, setVariant] = useState<Variant>("holdem");
  const [board, setBoard] = useState("Kh Kd 9c 9s 4d");
  const [hands, setHands] = useState(["Qc 4h", "Ac 2h"]);
  const [result, setResult] = useState<ShowdownResult | null>(null);
  const [error, setError] = useState(false);

  const run = () => {
    try {
      setResult(showdown(variant, parseCards(board), hands.map((h, i) => ({ id: String(i + 1), hole: parseCards(h) }))));
      setError(false);
    } catch {
      setResult(null);
      setError(true);
    }
  };

  return (
    <div className="stack">
      <section className="card stack">
        <label>
          {t("variant")}
          <select value={variant} onChange={(e) => setVariant(e.target.value as Variant)}>
            <option value="holdem">{t("holdem")}</option>
            <option value="omaha">{t("omaha")}</option>
          </select>
        </label>
        <label>
          {t("board")}
          <input value={board} onChange={(e) => setBoard(e.target.value)} dir="ltr" />
        </label>
        {hands.map((h, i) => (
          <label key={i}>
            {t("hand", { n: i + 1 })}
            <input value={h} dir="ltr" onChange={(e) => setHands((hs) => hs.map((x, j) => (j === i ? e.target.value : x)))} />
          </label>
        ))}
        <div className="row">
          <button className="btn secondary small" type="button" onClick={() => setHands((hs) => [...hs, ""])} disabled={hands.length >= 10}>
            +
          </button>
          <button className="btn secondary small" type="button" onClick={() => setHands((hs) => hs.slice(0, -1))} disabled={hands.length <= 1}>
            −
          </button>
          <button className="btn" type="button" onClick={run}>
            {t("evaluate")}
          </button>
        </div>
      </section>
      {error && <div className="alert">{t("invalid")}</div>}
      {result && (
        <section className="card stack">
          <h2>{result.winners.length > 1 ? t("split") : t("winner")}: {result.winners.map((w) => t("hand", { n: w })).join(" · ")}</h2>
          <p className="muted">
            {result.decidedBy.kind === "category"
              ? t("byCategory")
              : result.decidedBy.kind === "tiebreak"
                ? t("byTiebreak", { n: result.decidedBy.index + 1 })
                : result.decidedBy.kind === "tie"
                  ? t("tie")
                  : ""}
          </p>
          {result.hands.map((h) => (
            <div key={h.id} className="row" style={{ alignItems: "center" }}>
              <strong style={{ minWidth: 70 }}>{t("hand", { n: h.id })}</strong>
              <span dir="ltr">
                {h.value.cards.map((c, i) => (
                  <PlayingCard key={i} card={c} />
                ))}
              </span>
              <span className={result.winners.includes(h.id) ? "win" : "muted"}>{th(h.value.key)}</span>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}
