"use client";

import { type DrawResult, drawCommit, drawOrder, randomHex32 } from "@poker/domain";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { contributeDrawAction, judgeAction } from "@/app/actions/ideas";

// ---------------------------------------------------------------- companion referee

/** Board and hands of a disputed showdown; the server decides and records the verdict. */
export function RefereeForm({ gameId, names }: { gameId: string; names: string[] }) {
  const t = useTranslations("ideas");
  const [rows, setRows] = useState(2);
  return (
    <form action={judgeAction} className="stack">
      <input type="hidden" name="gameId" value={gameId} />
      <div className="row">
        <label>
          {t("variant")}
          <select name="variant" defaultValue="holdem">
            <option value="holdem">{t("holdem")}</option>
            <option value="omaha">{t("omaha")}</option>
          </select>
        </label>
        <label style={{ flex: 1 }}>
          {t("board")}
          <input name="board" required dir="ltr" placeholder="As Kd 7h 7c 2s" autoComplete="off" />
        </label>
      </div>
      <datalist id={`names-${gameId}`}>
        {names.map((n) => (
          <option key={n} value={n} />
        ))}
      </datalist>
      {Array.from({ length: rows }, (_, i) => (
        <div className="row" key={i}>
          <label>
            {t("hand", { n: i + 1 })}
            <input name={`label_${i}`} list={`names-${gameId}`} maxLength={40} placeholder={t("labelHint")} autoComplete="off" />
          </label>
          <label style={{ flex: 1 }}>
            {t("cards")}
            <input name={`cards_${i}`} required={i < 2} dir="ltr" placeholder={i === 0 ? "Qc 4h" : "Ac 2h"} autoComplete="off" />
          </label>
        </div>
      ))}
      <div className="row">
        <button className="btn secondary small" type="button" onClick={() => setRows((n) => Math.min(10, n + 1))} disabled={rows >= 10}>
          {t("addHand")}
        </button>
        <button className="btn secondary small" type="button" onClick={() => setRows((n) => Math.max(2, n - 1))} disabled={rows <= 2}>
          {t("removeHand")}
        </button>
        <button className="btn" type="submit">
          {t("judge")}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- fair draw

/** Adds this player's own randomness, made here in the browser, never by the server. */
export function ContributeButton({ drawId }: { drawId: string }) {
  const t = useTranslations("ideas");
  const [value, setValue] = useState("");
  // Made on first click (or on submit) so server and browser render the same markup.
  const submit = (fd: FormData) => {
    const v = value || randomHex32();
    fd.set("value", v);
    return contributeDrawAction(fd);
  };
  return (
    <form action={submit} className="stack">
      <input type="hidden" name="drawId" value={drawId} />
      <input type="hidden" name="value" value={value} />
      <p className="mono small break" dir="ltr">
        {value}
      </p>
      <div className="row">
        <button className="btn" type="submit">
          {t("contribute")}
        </button>
        <button className="btn secondary small" type="button" onClick={() => setValue(randomHex32())}>
          {t("newRandom")}
        </button>
      </div>
    </form>
  );
}

/** Recomputes the whole draw in this browser from the published values. */
export function DrawRecheck(props: {
  commit: string;
  seed: string;
  players: string[];
  contributions: { playerId: string; value: string }[];
  expected: string[];
}) {
  const t = useTranslations("ideas");
  const [state, setState] = useState<"working" | "ok" | "bad">("working");
  const { commit, seed, players, contributions, expected } = props;
  useEffect(() => {
    let live = true;
    (async () => {
      const okCommit = (await drawCommit(seed)) === commit;
      const r: DrawResult = await drawOrder({ seed, players, contributions });
      if (live) setState(okCommit && r.order.join() === expected.join() ? "ok" : "bad");
    })().catch(() => live && setState("bad"));
    return () => {
      live = false;
    };
  }, [commit, seed, players, contributions, expected]);
  return (
    <div className={`alert${state === "ok" ? " ok" : ""}`} role="status">
      {state === "working" ? t("recomputing") : state === "ok" ? t("recomputeOk") : t("recomputeBad")}
    </div>
  );
}
