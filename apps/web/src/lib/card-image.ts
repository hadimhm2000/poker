import { existsSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import QRCode from "qrcode";

/**
 * The result card: a PNG for Telegram and Instagram-style stories, drawn as SVG and rendered
 * with resvg (HarfBuzz shaping and bidi, so Persian and Arabic join and read right to left).
 * Fonts ship with the app (assets/fonts, SIL OFL): Vazirmatn for Persian, Arabic and Latin,
 * Noto Sans for Cyrillic and accented Latin.
 *
 * Design: a felt-green table at night — deep green gradient with a soft lamp glow, gold
 * frame and dividers, the champion in the spotlight, tidy ranked rows, the pot as a stat
 * chip and the verification QR as the corner stamp.
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
  return `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="20" fill="#fdfbf3"/><path d="${d}" fill="#0b2a20"/>`;
}

const GOLD = "#e8c160";
const GOLD_SOFT = "rgba(232, 193, 96, 0.5)";
const CREAM = "#f4f1e8";
const MIST = "#cfe3d8";
const WIN = "#7fe3a4";
const LOSS = "#ff9d9d";
const FLAT = "#d9d9d9";

/** Suit glyphs drawn as text, faded into the felt. */
function suits(rtl: boolean, w: number, h: number): string {
  const g: string[] = [];
  const glyphs = ["♠", "♥", "♦", "♣"];
  const spots: [number, number, number][] = [
    [0.08, 0.16, 300],
    [0.88, 0.3, 220],
    [0.14, 0.72, 260],
    [0.86, 0.82, 320],
  ];
  spots.forEach(([fx, fy, size], i) => {
    g.push(
      `<text x="${Math.round(fx * w)}" y="${Math.round(fy * h)}" font-family="Vazirmatn" font-size="${size}" fill="rgba(255,255,255,0.035)" text-anchor="middle">${glyphs[i]}</text>`,
    );
  });
  return g.join("");
}

export function cardSvg(input: CardInput, format: CardFormat = "post"): string {
  const { w, h, maxRows } = SIZES[format];
  const pad = 84;
  const dir = input.rtl ? "rtl" : "ltr";
  // Glyphs missing from the first family fall back to the second (Cyrillic in a Persian home).
  const FAMILY = input.rtl ? "Vazirmatn, Noto Sans" : "Noto Sans, Vazirmatn";
  // "start" / "end" in the reading direction, as absolute x positions.
  const start = input.rtl ? w - pad : pad;
  const end = input.rtl ? pad : w - pad;
  const anchorStart = input.rtl ? "end" : "start";
  const anchorEnd = input.rtl ? "start" : "end";
  const text = (x: number, y: number, size: number, body: string, o: { anchor: string; fill?: string; weight?: number; ltr?: boolean; spacing?: number }) =>
    `<text x="${x}" y="${y}" font-family="${FAMILY}" font-size="${size}" font-weight="${o.weight ?? 400}" fill="${o.fill ?? CREAM}" text-anchor="${o.anchor}" direction="${o.ltr ? "ltr" : dir}"${o.spacing ? ` letter-spacing="${o.spacing}"` : ""}>${esc(body)}</text>`;

  const parts: string[] = [];
  // Night table: vertical green gradient + a warm lamp glow over the reading-start corner.
  parts.push(
    `<defs>` +
      `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#114f3a"/><stop offset="0.55" stop-color="#0b3a29"/><stop offset="1" stop-color="#06231a"/></linearGradient>` +
      `<radialGradient id="glow" cx="${input.rtl ? 0.82 : 0.18}" cy="0.06" r="0.75"><stop offset="0" stop-color="rgba(232,193,96,0.16)"/><stop offset="0.5" stop-color="rgba(232,193,96,0.05)"/><stop offset="1" stop-color="rgba(232,193,96,0)"/></radialGradient>` +
      `<linearGradient id="chip" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(255,255,255,0.10)"/><stop offset="1" stop-color="rgba(255,255,255,0.045)"/></linearGradient>` +
      `<linearGradient id="goldbar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgba(232,193,96,0)"/><stop offset="0.5" stop-color="${GOLD}"/><stop offset="1" stop-color="rgba(232,193,96,0)"/></linearGradient>` +
      `</defs>`,
    `<rect width="${w}" height="${h}" fill="url(#bg)"/>`,
    `<rect width="${w}" height="${h}" fill="url(#glow)"/>`,
    suits(input.rtl, w, h),
    // double frame: thin gold line inside a soft outer line
    `<rect x="26" y="26" width="${w - 52}" height="${h - 52}" rx="40" fill="none" stroke="rgba(232,193,96,0.28)" stroke-width="2"/>`,
    `<rect x="38" y="38" width="${w - 76}" height="${h - 76}" rx="32" fill="none" stroke="${GOLD_SOFT}" stroke-width="2.5"/>`,
  );

  // ---- header ------------------------------------------------------------
  let y = pad + 56;
  parts.push(text(start, y, 30, input.brand, { anchor: anchorStart, fill: GOLD, weight: 700, spacing: 4 }));
  y += 96;
  parts.push(text(start, y, 72, clip(input.homeName, 22), { anchor: anchorStart, weight: 700 }));
  y += 66;
  parts.push(text(start, y, 40, `${input.title} · ${input.date}`, { anchor: anchorStart, fill: MIST }));
  y += 46;
  parts.push(
    `<rect x="${pad}" y="${y}" width="${w - 2 * pad}" height="4" rx="2" fill="url(#goldbar)"/>`,
  );
  y += 34;

  // ---- ranked rows -------------------------------------------------------
  const listed = input.rows.slice(0, input.rows.length > maxRows ? maxRows - 1 : maxRows);
  const champion = input.rows[0] && input.rows[0].sign > 0 ? input.rows[0] : null;
  const cardX = pad - 18;
  const cardW = w - 2 * pad + 36;
  // The tall story canvas shares its space between the rows (like space-between): a short
  // night gets tall, airy rows spread down the card instead of a half-empty middle.
  const rowsTop = y;
  const rowsBottom = h - pad - 320;
  const n = listed.length;
  const rowH = format === "story" ? Math.max(96, Math.min(170, Math.floor((rowsBottom - rowsTop) / Math.max(n, 1)))) : 84;
  const gap = n ? Math.max(0, (rowsBottom - rowsTop - n * rowH) / (n + 1)) : 0;
  const shown = listed;
  shown.forEach((r, i) => {
    const cy = rowsTop + gap + i * (rowH + gap) + rowH / 2;
    // row chip
    parts.push(`<rect x="${cardX}" y="${cy - rowH / 2 + 6}" width="${cardW}" height="${rowH - 12}" rx="20" fill="url(#chip)"/>`);
    if (i === 0 && champion) {
      // the champion: gold tint, a firm gold frame and a crown over the medal
      parts.push(`<rect x="${cardX}" y="${cy - rowH / 2 + 6}" width="${cardW}" height="${rowH - 12}" rx="20" fill="rgba(232,193,96,0.10)"/>`);
      parts.push(`<rect x="${cardX}" y="${cy - rowH / 2 + 6}" width="${cardW}" height="${rowH - 12}" rx="20" fill="none" stroke="${GOLD}" stroke-opacity="0.9" stroke-width="3"/>`);
    } else if (i < 3) {
      parts.push(`<rect x="${cardX}" y="${cy - rowH / 2 + 6}" width="${cardW}" height="${rowH - 12}" rx="20" fill="none" stroke="rgba(232,193,96,0.3)" stroke-width="1.5"/>`);
    }
    // rank medal or number
    const mx = input.rtl ? w - pad - 12 : pad + 12;
    if (i < 3 && r.sign > 0) {
      const MEDAL = ["#f3cf62", "#cfd6de", "#d69a5d"][i]!;
      parts.push(`<circle cx="${mx}" cy="${cy}" r="25" fill="${MEDAL}"/>`);
      parts.push(`<circle cx="${mx}" cy="${cy}" r="25" fill="none" stroke="rgba(0,0,0,0.18)" stroke-width="1.5"/>`);
      parts.push(text(mx, cy + 11, 32, String(i + 1), { anchor: "middle", fill: "#26221a", weight: 700, ltr: true }));
      if (i === 0 && champion) parts.push(text(mx, cy - 34, 34, "👑", { anchor: "middle", ltr: true }));
    } else {
      parts.push(text(mx, cy + 12, 34, String(i + 1), { anchor: "middle", fill: "rgba(207,227,216,0.75)", weight: 700, ltr: true }));
    }
    // name and amount
    const nx = input.rtl ? w - pad - 60 : pad + 60;
    const big = i === 0 && champion;
    parts.push(text(nx, cy + (big ? 17 : 15), big ? 52 : 46, clip(r.name, 20), { anchor: anchorStart, weight: 700 }));
    const color = r.sign > 0 ? WIN : r.sign < 0 ? LOSS : FLAT;
    parts.push(text(end, cy + (big ? 17 : 15), big ? 52 : 46, r.amount, { anchor: anchorEnd, fill: color, weight: 700, ltr: true }));
  });
  if (shown.length < input.rows.length) {
    parts.push(text(start, rowsTop + gap + shown.length * (rowH + gap) + 22, 33, input.moreLabel(input.rows.length - shown.length), { anchor: anchorStart, fill: MIST }));
  }

  // ---- footer: pot stat + verification stamp ------------------------------
  // Fixed stack inside the chip: label, big pot, verify note, hash — spaced for both formats.
  const qr = format === "story" ? 250 : 215;
  const qx = input.rtl ? pad : w - pad - qr;
  const qy = h - pad - qr - 6;
  parts.push(qrPath(input.verifyUrl, qx, qy, qr));
  const chipW = w - 2 * pad - qr - 36;
  const chipX = input.rtl ? pad + qr + 36 : pad;
  const chipH = qr + 16;
  parts.push(`<rect x="${chipX}" y="${qy - 2}" width="${chipW}" height="${chipH}" rx="24" fill="rgba(255,255,255,0.055)"/>`);
  const tx = input.rtl ? chipX + chipW - 30 : chipX + 30;
  parts.push(text(tx, qy + 54, 31, input.potLabel, { anchor: anchorStart, fill: MIST }));
  parts.push(text(tx, qy + 124, format === "story" ? 64 : 58, input.pot, { anchor: anchorStart, weight: 700 }));
  parts.push(text(tx, qy + chipH - 52, 29, input.verifyLabel, { anchor: anchorStart, fill: GOLD }));
  parts.push(text(tx, qy + chipH - 16, 24, input.hashShort, { anchor: anchorStart, fill: "rgba(159,184,172,0.9)", ltr: true }));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${parts.join("")}</svg>`;
}

export function renderCard(input: CardInput, format: CardFormat = "post"): Buffer {
  const r = new Resvg(cardSvg(input, format), {
    font: { fontFiles: fonts(), loadSystemFonts: false, defaultFontFamily: "Vazirmatn" },
  });
  return r.render().asPng();
}
