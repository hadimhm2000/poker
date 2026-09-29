"use client";

import { useTranslations } from "next-intl";
import { useActionState } from "react";
import { type PreviewState, confirmImportAction, previewImportAction } from "@/app/actions/import";
import { Link } from "@/i18n/navigation";

export function ImportForm({ homeId, divisor, suffix }: { homeId: string; divisor: number; suffix: string }) {
  const t = useTranslations("import");
  const te = useTranslations("errors");
  const ts = useTranslations("stats");
  const [preview, previewAction, previewing] = useActionState<PreviewState, FormData>(previewImportAction, { stage: "idle" });
  const [result, confirmAction, importing] = useActionState<PreviewState, FormData>(confirmImportAction, { stage: "idle" });
  const fmt = (n: number) => `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 2, signDisplay: "exceptZero" }).format(n / divisor)}${suffix}`;

  if (result.stage === "done") {
    return (
      <div className="card">
        <p>{t("done", { count: result.count })}</p>
        <Link className="btn" href={`/homes/${homeId}/stats`}>
          {ts("title")}
        </Link>
      </div>
    );
  }
  const error = result.stage === "error" ? result.code : preview.stage === "error" ? preview.code : null;
  const games = preview.stage === "preview" ? preview.games : [];
  const ready = games.filter((g) => g.status === "ok");

  return (
    <div className="stack">
      {error && (
        <div className="alert">
          {error === "noColumns" ? t("noColumns") : error === "tooBig" ? t("tooBig") : error === "PRO" ? ts("proOnly") : te(error)}
        </div>
      )}
      <form action={previewAction} className="card row">
        <input type="hidden" name="homeId" value={homeId} />
        <label style={{ flex: 1 }}>
          {t("file")}
          <input type="file" name="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required />
        </label>
        <button className="btn secondary" type="submit" disabled={previewing}>
          {t("preview")}
        </button>
      </form>

      {preview.stage === "preview" && (
        <section className="card table-wrap">
          <p className="small muted">{t("columns", { columns: preview.columns.join(" · ") })}</p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>{ts("date")}</th>
                <th>{t("rows")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {games.map((g) => (
                <tr key={g.key}>
                  <td>{g.number ?? ""}</td>
                  <td className="small">{g.date}</td>
                  <td className="small">
                    {g.rows.map((r) => `${r.name} ${fmt(r.cashOut - r.totalIn)}`).join(" · ")}
                  </td>
                  <td className={g.status === "ok" ? "win small" : "loss small"}>
                    {g.status === "ok"
                      ? t("ok")
                      : g.status === "unbalanced"
                        ? t("unbalanced", { difference: fmt(g.difference) })
                        : g.status === "duplicate"
                          ? t("duplicate")
                          : g.status === "duplicateInFile"
                            ? t("inFile")
                            : "✕"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {games.length > ready.length && <p className="small muted">{t("skipped", { count: games.length - ready.length })}</p>}
          {ready.length > 0 && (
            <form action={confirmAction}>
              <input type="hidden" name="homeId" value={homeId} />
              <input type="hidden" name="games" value={JSON.stringify(ready.map((g) => ({ date: g.date, rows: g.rows })))} />
              <button className="btn" type="submit" disabled={importing}>
                {t("confirm", { count: ready.length })}
              </button>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
