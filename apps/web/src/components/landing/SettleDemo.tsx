"use client";

import { settle } from "@poker/domain";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { SAMPLE_GAME, nameOf } from "./sample";

/** The product doing its job: change a cash-out and the real settle() prints who pays whom. */
export function SettleDemo() {
  const t = useTranslations("game");
  const tl = useTranslations("landing");
  const locale = useLocale();
  const nf = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const [outs, setOuts] = useState(SAMPLE_GAME.players.map((p) => String(p.cashOut)));

  const cash = outs.map((v) => Math.max(0, Number.parseInt(v, 10) || 0));
  const nets = SAMPLE_GAME.players.map((p, i) => cash[i]! - p.buyIn);
  const difference = nets.reduce((a, b) => a + b, 0);
  const balanced = difference === 0;
  const transfers = balanced ? settle(SAMPLE_GAME.players.map((p, i) => ({ playerId: p.id, amount: nets[i]! }))) : [];
  const signed = (n: number) => (n > 0 ? `+${nf.format(n)}` : n < 0 ? `−${nf.format(-n)}` : nf.format(0));

  return (
    <div className="ui" data-ui>
      <div className="ui-head">
        <h2>{t("title", { number: SAMPLE_GAME.number })}</h2>
        <span className={`badge${balanced ? " live" : ""}`}>{balanced ? t("status_balanced") : t("status_live")}</span>
      </div>
      <div className="table-wrap">
        <table className="ui-table">
          <thead>
            <tr>
              <th scope="col">{t("player")}</th>
              <th scope="col" className="num">{t("in")}</th>
              <th scope="col" className="num">{t("cashOut")}</th>
              <th scope="col" className="num">{t("net")}</th>
            </tr>
          </thead>
          <tbody>
            {SAMPLE_GAME.players.map((p, i) => (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td className="num">{nf.format(p.buyIn)}</td>
                <td className="num">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={0}
                    step={1}
                    value={outs[i]}
                    aria-label={`${p.name}: ${t("cashOut")}`}
                    onChange={(e) => setOuts((o) => o.map((v, j) => (j === i ? e.target.value : v)))}
                  />
                </td>
                <td className={`num ${nets[i]! > 0 ? "win" : nets[i]! < 0 ? "loss" : "zero"}`}>{signed(nets[i]!)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="ui-out" aria-live="polite">
        <h3>{tl("f2Title")}</h3>
        {balanced ? (
          <ul className="pays">
            {transfers.map((x) => (
              <li key={`${x.from}${x.to}`}>
                <span>{nameOf(x.from)}</span>
                <span className="arrow" aria-hidden="true" />
                <span>{nameOf(x.to)}</span>
                <span className="num">{nf.format(x.amount)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="loss">{t("blocked_UNBALANCED", { difference: signed(difference) })}</p>
        )}
      </div>
    </div>
  );
}
