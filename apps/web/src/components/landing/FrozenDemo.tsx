import { getTranslations } from "next-intl/server";
import { SAMPLE_GAME } from "./sample";

/** A closed game: the same night as the hero, now read-only. */
export async function FrozenDemo() {
  const t = await getTranslations("game");
  return (
    <div className="ui" data-ui>
      <div className="ui-head">
        <h3>{t("title", { number: SAMPLE_GAME.number })}</h3>
        <span className="badge">{t("status_closed")}</span>
      </div>
      <table className="ui-table">
        <tbody>
          {SAMPLE_GAME.players.map((p) => {
            const net = p.cashOut - p.buyIn;
            return (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td className="num">{p.cashOut}</td>
                <td className={`num ${net > 0 ? "win" : "loss"}`}>{net > 0 ? `+${net}` : `−${-net}`}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="ui-foot">
        <p>{t("warning")}</p>
        <button className="btn small" type="button" disabled>
          {t("save")}
        </button>
      </div>
    </div>
  );
}
