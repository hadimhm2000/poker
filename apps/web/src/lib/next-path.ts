/** Only our own pages that make sense after signing in (no open redirect). */
export function safeNext(v: unknown): string | null {
  const s = typeof v === "string" ? v : "";
  return /^\/(invite|join|games|homes)\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)?$/.test(s) ? s : null;
}
