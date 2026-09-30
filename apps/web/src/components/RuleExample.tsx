import { type RuleExample as Example, exampleWinners, parseCards } from "@poker/domain";
import { getTranslations } from "next-intl/server";
import { PlayingCard } from "./Card";

export function CardRow({ cards }: { cards: string }) {
  return (
    <span className="cards-row">
      {parseCards(cards).map((c, i) => (
        <PlayingCard key={i} card={c} />
      ))}
    </span>
  );
}

/** A rule's example drawn with cards; who wins comes from the hand engine. */
export async function RuleExample({ example, reveal = true }: { example: Example; reveal?: boolean }) {
  const t = await getTranslations("rules");
  const winners = exampleWinners(example);
  const outcome = (label: string) =>
    !winners.includes(label) ? t("loses") : winners.length > 1 ? t("split") : t("winner");
  return (
    <div className="rule-example">
      {example.kind === "showdown" && (
        <div className="who">
          <span className="small muted">{t("board")}</span>
          <CardRow cards={example.board} />
        </div>
      )}
      {example.hands.map((h) => (
        <div key={h.label} className={`who${reveal && winners.includes(h.label) ? " win" : ""}`}>
          <span className="small muted">{t("handLabel", { label: h.label })}</span>
          <CardRow cards={h.cards} />
          {reveal && <strong className="small">{outcome(h.label)}</strong>}
        </div>
      ))}
    </div>
  );
}
