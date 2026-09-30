"use client";

import { useLocale, useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { type HomeMoney, formatAmount, parseAmount, toInputValue } from "@/lib/format";

// ---------------------------------------------------------------- live refresh

/** Re-renders the page whenever the game changes on the server (Server-Sent Events). */
export function LiveRefresh({ gameId }: { gameId: string }) {
  const router = useRouter();
  const t = useTranslations("live");
  const [state, setState] = useState<"connecting" | "live" | "offline">("connecting");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const es = new EventSource(`/api/games/${gameId}/live`);
    es.onopen = () => setState("live");
    es.onerror = () => setState(navigator.onLine ? "connecting" : "offline");
    es.addEventListener("change", () => {
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), 100);
    });
    // Coming back online or to the tab: catch up on anything missed.
    const catchUp = () => router.refresh();
    const onVisible = () => document.visibilityState === "visible" && catchUp();
    window.addEventListener("online", catchUp);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      es.close();
      clearTimeout(timer);
      window.removeEventListener("online", catchUp);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [gameId, router]);

  return (
    <span className={`live-dot ${state}`} role="status" aria-live="polite">
      {t(`conn_${state}`)}
    </span>
  );
}

// ---------------------------------------------------------------- host change queue

export type QueuedOp =
  | { kind: "rebuy"; opKey: string; playerId: string; amount: number }
  | { kind: "cash_out"; opKey: string; playerId: string; amount: number | null }
  | { kind: "answer"; opKey: string; requestId: string; approve: boolean };

interface Queue {
  pending: QueuedOp[];
  enqueue: (op: QueuedOp) => void;
}

const QueueContext = createContext<Queue | null>(null);

const load = (key: string): QueuedOp[] => {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const save = (key: string, ops: QueuedOp[]) => {
  try {
    if (ops.length) localStorage.setItem(key, JSON.stringify(ops));
    else localStorage.removeItem(key);
  } catch {}
};

/**
 * The host's changes go through a queue kept on the phone. On a weak connection they wait
 * and are sent in order when the connection is back; each carries a key so a resend after a
 * dropped answer is applied once.
 */
export function HostQueue({ gameId, children }: { gameId: string; children: React.ReactNode }) {
  const router = useRouter();
  const t = useTranslations("live");
  const te = useTranslations("errors");
  const key = `poker-ops:${gameId}`;
  const [pending, setPending] = useState<QueuedOp[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const sending = useRef(false);
  const ops = useRef<QueuedOp[]>([]);

  const update = useCallback(
    (next: QueuedOp[]) => {
      ops.current = next;
      save(key, next);
      setPending(next);
    },
    [key],
  );

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    let changed = false;
    try {
      while (ops.current.length) {
        const op = ops.current[0]!;
        let res: Response;
        try {
          res = await fetch(`/api/games/${gameId}/ops`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(op),
            signal: AbortSignal.timeout(10_000),
          });
        } catch {
          setWaiting(true);
          break;
        }
        if (res.status >= 500 || res.status === 429) {
          setWaiting(true);
          break;
        }
        setWaiting(false);
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setError(body.error ?? "ERROR");
        }
        update(ops.current.slice(1));
        changed = true;
      }
    } finally {
      sending.current = false;
      if (changed) router.refresh();
    }
  }, [gameId, router, update]);

  useEffect(() => {
    ops.current = load(key);
    setPending(ops.current);
    void flush();
    const retry = setInterval(() => ops.current.length && void flush(), 5000);
    const online = () => void flush();
    window.addEventListener("online", online);
    return () => {
      clearInterval(retry);
      window.removeEventListener("online", online);
    };
  }, [key, flush]);

  const enqueue = useCallback(
    (op: QueuedOp) => {
      setError(null);
      update([...ops.current, op]);
      void flush();
    },
    [flush, update],
  );

  return (
    <QueueContext.Provider value={{ pending, enqueue }}>
      {pending.length > 0 && (
        <div className="alert" role="status">
          {waiting ? t("queued", { count: pending.length }) : t("sending", { count: pending.length })}
        </div>
      )}
      {error && (
        <div className="alert" role="alert">
          {te.has(error) ? te(error) : te("ERROR")}
        </div>
      )}
      {children}
    </QueueContext.Provider>
  );
}

function useQueue(): Queue {
  const q = useContext(QueueContext);
  if (!q) throw new Error("HostQueue missing");
  return q;
}

const newKey = () => crypto.randomUUID();

/** Rebuy button and cash-out field for one row of the host's table. */
export function HostEntryControls({
  playerId,
  defaultBuyIn,
  cashOut,
  home,
}: {
  playerId: string;
  defaultBuyIn: number;
  cashOut: number | null;
  home: HomeMoney;
}) {
  const t = useTranslations("game");
  const tl = useTranslations("live");
  const locale = useLocale();
  const { pending, enqueue } = useQueue();
  const [value, setValue] = useState(toInputValue(cashOut, home.unitDivisor));
  const [invalid, setInvalid] = useState(false);
  const mine = pending.filter((o) => "playerId" in o && o.playerId === playerId);
  const waitingIn = mine.reduce((s, o) => (o.kind === "rebuy" ? s + o.amount : s), 0);
  const waitingOut = mine.filter((o) => o.kind === "cash_out").at(-1);

  // A new value from the server (another device, or our own change arriving) replaces the field.
  const [synced, setSynced] = useState(cashOut);
  if (synced !== cashOut) {
    setSynced(cashOut);
    setValue(toInputValue(cashOut, home.unitDivisor));
  }

  const submitCashOut = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = value.trim();
    const amount = raw === "" ? null : parseAmount(raw, home.unitDivisor);
    if (raw !== "" && amount === null) return setInvalid(true);
    setInvalid(false);
    enqueue({ kind: "cash_out", opKey: newKey(), playerId, amount });
  };

  return (
    <div className="row" style={{ justifyContent: "flex-end", flexWrap: "nowrap" }}>
      <button
        className="btn small secondary"
        type="button"
        title={formatAmount(defaultBuyIn, home, locale)}
        onClick={() => enqueue({ kind: "rebuy", opKey: newKey(), playerId, amount: defaultBuyIn })}
        disabled={defaultBuyIn <= 0}
      >
        + {t("rebuy")}
      </button>
      {waitingIn > 0 && <span className="badge">{tl("waitingAmount", { amount: formatAmount(waitingIn, home, locale, true) })}</span>}
      <form onSubmit={submitCashOut} className="row" style={{ flexWrap: "nowrap" }}>
        <input
          name="cashOut"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          style={{ maxWidth: 110 }}
          dir="ltr"
          aria-label={t("cashOut")}
          aria-invalid={invalid || undefined}
        />
        <button className="btn small" type="submit">
          {t("save")}
        </button>
      </form>
      {waitingOut && <span className="badge">{tl("waiting")}</span>}
    </div>
  );
}

/** Approve / reject buttons for a player's rebuy request. */
export function AnswerRequest({ requestId }: { requestId: string }) {
  const t = useTranslations("live");
  const { pending, enqueue } = useQueue();
  if (pending.some((o) => o.kind === "answer" && o.requestId === requestId)) {
    return <span className="badge">{t("waiting")}</span>;
  }
  return (
    <span className="row" style={{ flexWrap: "nowrap" }}>
      <button className="btn small" type="button" onClick={() => enqueue({ kind: "answer", opKey: newKey(), requestId, approve: true })}>
        {t("approve")}
      </button>
      <button
        className="btn small secondary"
        type="button"
        onClick={() => enqueue({ kind: "answer", opKey: newKey(), requestId, approve: false })}
      >
        {t("reject")}
      </button>
    </span>
  );
}

/** Copy a link (the join link) to the clipboard. */
export function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn small secondary"
      type="button"
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          },
          () => {},
        )
      }
    >
      {copied ? done : label}
    </button>
  );
}
