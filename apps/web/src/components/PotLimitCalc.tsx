"use client";

import { potLimitMax } from "@poker/domain";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { normalizeDigits } from "@/lib/format";

const toInt = (s: string) => {
  const v = normalizeDigits(s.trim());
  return /^\d+$/.test(v) ? Number(v) : NaN;
};

export function PotLimitCalc() {
  const t = useTranslations("rules");
  const locale = useLocale();
  const [pot, setPot] = useState("150");
  const [bet, setBet] = useState("50");
  const [inn, setIn] = useState("0");
  let result: ReturnType<typeof potLimitMax> | null = null;
  try {
    result = potLimitMax({ pot: toInt(pot), currentBet: toInt(bet), alreadyIn: toInt(inn) });
  } catch {
    result = null;
  }
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const field = (label: string, value: string, set: (v: string) => void) => (
    <label>
      {label}
      <input inputMode="numeric" value={value} onChange={(e) => set(e.target.value)} dir="ltr" />
    </label>
  );
  return (
    <div className="stack">
      <div className="grid" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
        {field(t("potCalcPot"), pot, setPot)}
        {field(t("potCalcBet"), bet, setBet)}
        {field(t("potCalcIn"), inn, setIn)}
      </div>
      {result ? (
        <div className="stats" aria-live="polite">
          <div className="stat">
            <div className="label">{t("potCalcToCall")}</div>
            <div className="value num">{n(result.toCall)}</div>
          </div>
          <div className="stat">
            <div className="label">{t("potCalcRaiseTo")}</div>
            <div className="value num">{n(result.raiseTo)}</div>
          </div>
          <div className="stat">
            <div className="label">{t("potCalcPutIn")}</div>
            <div className="value num">{n(result.putIn)}</div>
          </div>
        </div>
      ) : (
        <p className="alert" role="alert">
          {t("potCalcInvalid")}
        </p>
      )}
    </div>
  );
}
