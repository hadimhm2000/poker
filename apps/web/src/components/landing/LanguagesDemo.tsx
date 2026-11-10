import { getTranslations } from "next-intl/server";
import { dir, localeNames, locales } from "@/i18n/routing";

/** The same ledger header in every language the product ships, read from the real message files. */
export async function LanguagesDemo() {
  const rows = await Promise.all(
    locales.map(async (l) => {
      const t = await getTranslations({ locale: l, namespace: "game" });
      return { l, name: localeNames[l], player: t("player"), cashOut: t("cashOut"), net: t("net"), closed: t("status_closed") };
    }),
  );
  return (
    <div className="ui" data-ui>
      <table className="ui-table langs">
        <tbody>
          {rows.map((r) => (
            <tr key={r.l} lang={r.l} dir={dir(r.l)}>
              <th scope="row">{r.name}</th>
              <td>{r.player}</td>
              <td>{r.cashOut}</td>
              <td>{r.net}</td>
              <td>
                <span className="badge">{r.closed}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
