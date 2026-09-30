import { existsSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import QRCode from "qrcode";

/**
 * The result card: a PNG for Telegram and Instagram-style stories, drawn as SVG and rendered
 * with resvg (HarfBuzz shaping and bidi, so Persian and Arabic join and read right to left).
 * Fonts ship with the app (assets/fonts, SIL OFL): Vazirmatn for Persian, Arabic and Latin,
 * Noto Sans for Cyrillic and accented Latin.
 */

export type CardFormat = "post" | "story";

export interface CardInput {
  rtl: boolean;
  homeName: string;
  title: string; // "Game #12"
  date: string;
  potLabel: string;
  pot: string;
  rows: { name: string; amount: string; sign: -1 | 0 | 1 }[];
  moreLabel: (n: number) => string;
  verifyLabel: string;
  verifyUrl: string;
  hashShort: string;
  brand: string;
}

const SIZES: Record<CardFormat, { w: number; h: number; maxRows: number }> = {
  post: { w: 1080, h: 1350, maxRows: 9 },
  story: { w: 1080, h: 1920, maxRows: 14 },
};

let fontFiles: string[] | null = null;
function fonts(): string[] {
  if (fontFiles) return fontFiles;
  // `next start` and the tests run in apps/web; a monorepo-root cwd is also accepted.
  const dir = [join(process.cwd(), "assets/fonts"), join(process.cwd(), "apps/web/assets/fonts")].find((d) => existsSync(d));
  if (!dir) throw new Error("card fonts not found (assets/fonts)");
  fontFiles = ["Vazirmatn-Regular.ttf", "Vazirmatn-Bold.ttf", "NotoSans-Regular.ttf", "NotoSans-Bold.ttf"].map((f) => join(dir, f));
  return fontFiles;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Cut long names by grapheme so a combining mark or emoji is never split. */
function clip(s: string, max: number): string {
  const parts = [...new Intl.Segmenter().segment(s)].map((x) => x.segment);
  return parts.length <= max ? s : `${parts.slice(0, max - 1).join("")}…`;
}

function qrPath(text: string, x: number, y: number, size: number): string {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const quiet = 2;
  const cell = size / (n + quiet * 2);
  let d = "";
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.get(r, c)) {
        const px = x + (c + quiet) * cell;
        const py = y + (r + quiet) * cell;
        d += `M${px.toFixed(2)} ${py.toFixed(2)}h${cell.toFixed(2)}v${cell.toFixed(2)}h${(-cell).toFixed(2)}z`;
      }
    }
  }
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="16" fill="#fff"/><path d="${d}" fill="#0b2a20"/>`;
}


const MEDALS = ["#e8c160", "#c9d1d9", "#d08a4e"];

export function cardSvg(input: CardInput, format: CardFormat = "post"): string {
  const { w, h, maxRows } = SIZES[format];
  const pad = 80;
  const dir = input.rtl ? "rtl" : "ltr";
  // Glyphs missing from the first family fall back to the second (Cyrillic in a Persian home).
  const FAMILY = input.rtl ? "Vazirmatn, Noto Sans" : "Noto Sans, Vazirmatn";
  // "start" / "end" in the reading direction, as absolute x positions.
  const start = input.rtl ? w - pad : pad;
  const end = input.rtl ? pad : w - pad;
  const anchorStart = input.rtl ? "end" : "start";
  const anchorEnd = input.rtl ? "start" : "end";
  const text = (x: number, y: number, size: number, body: string, o: { anchor: string; fill?: string; weight?: number; ltr?: boolean }) =>
    `<text x="${x}" y="${y}" font-family="${FAMILY}" font-size="${size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? "#f4f1e8"}" text-anchor="${o.anchor}" direction="${o.ltr ? "ltr" : dir}">${esc(body)}</text>`;

  const parts: string[] = [];
  parts.push(
    `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0f4a37"/><stop offset="1" stop-color="#06231a"/></linearGradient></defs>`,
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>`,
    `<rect x="24" y="24" width="${w - 48}" height="${h - 48}" rx="36" fill="none" stroke="#e8c160" stroke-opacity="0.55" stroke-width="3"/>`,
  );

  let y = pad + 60;
  parts.push(text(start, y, 30, input.brand, { anchor: anchorStart, fill: "#e8c160", weight: 700 }));
  y += 90;
  parts.push(text(start, y, 68, clip(input.homeName, 22), { anchor: anchorStart, weight: 700 }));
  y += 64;
  parts.push(text(start, y, 38, `${input.title} · ${input.date}`, { anchor: anchorStart, fill: "#cfe3d8" }));
  y += 50;
  parts.push(`<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="#e8c160" stroke-opacity="0.4" stroke-width="2"/>`);

  const shown = input.rows.slice(0, input.rows.length > maxRows ? maxRows - 1 : maxRows);
  const rowH = format === "story" ? 88 : 80;
  y += 30;
  shown.forEach((r, i) => {
    const cy = y + i * rowH + rowH / 2;
    if (i % 2 === 0) {
      parts.push(`<rect x="${pad - 20}" y="${cy - rowH / 2 + 4}" width="${w - 2 * pad + 40}" height="${rowH - 8}" rx="18" fill="#ffffff" fill-opacity="0.05"/>`);
    }
    const mx = input.rtl ? w - pad - 24 : pad + 24;
    if (i < 3 && r.sign > 0) {
      parts.push(`<circle cx="${mx}" cy="${cy}" r="22" fill="${MEDALS[i]}"/>`);
      parts.push(text(mx, cy + 11, 30, String(i + 1), { anchor: "middle", fill: "#1b1b1b", weight: 700, ltr: true }));
    }
    const nx = input.rtl ? w - pad - 70 : pad + 70;
    parts.push(text(nx, cy + 15, 44, clip(r.name, 20), { anchor: anchorStart, weight: 700 }));
    const color = r.sign > 0 ? "#6ee7a0" : r.sign < 0 ? "#ff8f8f" : "#d9d9d9";
    parts.push(text(end, cy + 15, 44, r.amount, { anchor: anchorEnd, fill: color, weight: 700, ltr: true }));
  });
  y += shown.length * rowH;
  if (shown.length < input.rows.length) {
    y += 20;
    parts.push(text(start, y + 20, 34, input.moreLabel(input.rows.length - shown.length), { anchor: anchorStart, fill: "#cfe3d8" }));
    y += 40;
  }

  // Footer: pot on the reading-start side, verification QR on the end side.
  const qr = format === "story" ? 260 : 220;
  const qx = input.rtl ? pad : w - pad - qr;
  const qy = h - pad - qr - 10;
  parts.push(qrPath(input.verifyUrl, qx, qy, qr));
  parts.push(text(start, qy + 50, 32, input.potLabel, { anchor: anchorStart, fill: "#cfe3d8" }));
  parts.push(text(start, qy + 110, 56, input.pot, { anchor: anchorStart, weight: 700 }));
  parts.push(text(start, qy + qr - 40, 28, input.verifyLabel, { anchor: anchorStart, fill: "#e8c160" }));
  parts.push(text(start, qy + qr, 24, input.hashShort, { anchor: anchorStart, fill: "#9fb8ac", ltr: true }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`;
}

export function renderCard(input: CardInput, format: CardFormat = "post"): Buffer {
  const r = new Resvg(cardSvg(input, format), {
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: "Vazirmatn" },
  });
  return r.render().asPng();
}
