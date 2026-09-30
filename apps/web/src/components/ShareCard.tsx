"use client";

import { useState, useSyncExternalStore } from "react";

const noop = () => () => {};

/** Share the result card image through the phone's share sheet (Telegram, Instagram story…). */
export function ShareCard({ src, label, filename }: { src: string; label: string; filename: string }) {
  const [busy, setBusy] = useState(false);
  // False on the server and during hydration, then the browser's answer.
  const supported = useSyncExternalStore(noop, () => typeof navigator.canShare === "function", () => false);
  if (!supported) return null;
  const share = async () => {
    setBusy(true);
    try {
      const blob = await (await fetch(src)).blob();
      const file = new File([blob], filename, { type: "image/png" });
      if (navigator.canShare({ files: [file] })) await navigator.share({ files: [file] });
    } catch {
      // Cancelled by the user, or sharing files is not allowed here: the download links remain.
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="btn small" type="button" onClick={share} disabled={busy}>
      {label}
    </button>
  );
}
