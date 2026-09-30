"use client";

import { useState } from "react";

/**
 * A date-and-time field in the user's own time zone. The form receives an ISO instant
 * (hidden field), so the server never has to guess the zone.
 */
export function LocalDateTime({ name, label }: { name: string; label: string }) {
  const [iso, setIso] = useState("");
  return (
    <label>
      {label}
      <input
        type="datetime-local"
        required
        dir="ltr"
        onChange={(e) => {
          const d = new Date(e.target.value);
          setIso(Number.isNaN(d.getTime()) ? "" : d.toISOString());
        }}
      />
      <input type="hidden" name={name} value={iso} />
    </label>
  );
}
