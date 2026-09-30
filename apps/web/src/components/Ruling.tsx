import type { RulingRow } from "@poker/db";
import { rulingAnchor } from "@poker/domain";
import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/navigation";
import { formatDate } from "@/lib/format";
import { CardRow } from "./RuleExample";

/** One verdict from a game's referee log: cards, winner, reason and the rule. */
export async function Ruling({ r }: { r: RulingRow }) {
  const locale = await getLocale();
  const t = await getTranslations("ideas");
  const th = await getTranslations("hand");
  const tr = await getTranslations("rules");
  const reason =
    r.decidedBy.kind === "category"
      ? t("byCategory")
      : r.decidedBy.kind === "tiebreak"
        ? t("byTiebreak", { n: r.decidedBy.index + 1 })
        : r.decidedBy.kind === "tie"
          ? t("byTie")
          : "";
  return (
    <article className="rule-example">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
        <strong className="win">
          ⚖️ {r.winners.length > 1 ? t("verdictSplit", { names: r.winners.join(" · ") }) : t("verdictWinner", { name: r.winners[0]! })}
        </strong>
        <span className="small muted">
          {formatDate(r.createdAt, locale, true)} {r.via === "telegram" && `· ${t("viaTelegram")}`}
        </span>
      </div>
      <div className="who">
        <span className="small muted">{t("board")}</span>
        <CardRow cards={r.board.join(" ")} />
      </div>
      {r.hands.map((h) => (
        <div key={h.label} className={`who${r.winners.includes(h.label) ? " win" : ""}`}>
          <strong className="small">{h.label}</strong>
          <CardRow cards={h.cards.join(" ")} />
          <span aria-hidden="true">→</span>
          <CardRow cards={h.best.join(" ")} />
          <span className="small">{th(h.key as "pair")}</span>
        </div>
      ))}
      <p className="small" style={{ margin: 0 }}>
        {reason}{" "}
        <Link href={`/rules${rulingAnchor(r.situation)}`}>
          {r.situation ? tr(`s.${r.situation}.title`) : t("handRankings")}
        </Link>
      </p>
    </article>
  );
}
