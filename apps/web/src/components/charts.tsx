// Server-rendered SVG charts: no chart library, nothing to load, CSP-friendly.
// Hover shows a native tooltip (<title>) for every point and bar; the tables on the same
// page carry the same numbers for anyone who cannot use the chart.

const SERIES = 8;
export const seriesColor = (slot: number) => `var(--series-${(slot % SERIES) + 1})`;

interface Point {
  x: number;
  y: number;
  label: string;
}

export interface LineSeries {
  key: string;
  name: string;
  /** Fixed slot per player, so a filter never repaints survivors. */
  slot: number;
  points: Point[];
}

function niceTicks(min: number, max: number, count = 5): number[] {
  if (min === max) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = Math.floor(min / step) * step; v <= max + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

export function LineChart({
  series,
  xLabels,
  format,
  height = 280,
  title,
}: {
  series: LineSeries[];
  /** label for each x (game index) */
  xLabels: string[];
  format: (v: number) => string;
  height?: number;
  title: string;
}) {
  const width = 720;
  const pad = { top: 12, right: 16, bottom: 26, left: 64 };
  const all = series.flatMap((s) => s.points.map((p) => p.y));
  const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
  const yMin = ticks[0]!;
  const yMax = ticks[ticks.length - 1]!;
  const n = Math.max(1, xLabels.length - 1);
  const x = (i: number) => pad.left + (i / n) * (width - pad.left - pad.right);
  const y = (v: number) => pad.top + (1 - (v - yMin) / (yMax - yMin || 1)) * (height - pad.top - pad.bottom);
  const xStep = Math.max(1, Math.ceil(xLabels.length / 10));

  return (
    <figure style={{ margin: 0 }}>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
        {ticks.map((t) => (
          <g key={t}>
            <line className={t === 0 ? "zero" : "gridline"} x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} />
            <text x={pad.left - 8} y={y(t) + 4} textAnchor="end">
              {format(t)}
            </text>
          </g>
        ))}
        {xLabels.map((l, i) =>
          i % xStep === 0 || i === xLabels.length - 1 ? (
            <text key={i} x={x(i)} y={height - 8} textAnchor="middle">
              {l}
            </text>
          ) : null,
        )}
        {series.map((s) => {
          const color = seriesColor(s.slot);
          const d = s.points.map((p, i) => `${i ? "L" : "M"}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join("");
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              {s.points.map((p, i) => (
                <g key={i}>
                  <circle cx={x(p.x)} cy={y(p.y)} r={9} className="hit">
                    <title>{`${s.name} · ${p.label}: ${format(p.y)}`}</title>
                  </circle>
                  <circle className="mark" cx={x(p.x)} cy={y(p.y)} r={3} fill={color} stroke="var(--surface)" strokeWidth={2} pointerEvents="none" />
                </g>
              ))}
            </g>
          );
        })}
      </svg>
      {series.length > 1 && (
        <div className="legend">
          {series.map((s) => (
            <span key={s.key} style={{ "--c": seriesColor(s.slot) } as React.CSSProperties}>
              {s.name}
            </span>
          ))}
        </div>
      )}
    </figure>
  );
}

/** Horizontal bars for a signed value (net per player): blue for profit, red for loss. */
export function DivergingBars({
  rows,
  format,
  title,
}: {
  rows: { key: string; name: string; value: number }[];
  format: (v: number) => string;
  title: string;
}) {
  const width = 720;
  const rowH = 26;
  const labelW = 120;
  const valueW = 90;
  const height = rows.length * rowH + 8;
  const maxAbs = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  const hasNeg = rows.some((r) => r.value < 0);
  const plotL = labelW;
  const plotR = width - valueW;
  const zero = hasNeg ? (plotL + plotR) / 2 : plotL;
  const scale = (hasNeg ? (plotR - plotL) / 2 : plotR - plotL) / maxAbs;

  return (
    <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={title}>
      <line className="zero" x1={zero} x2={zero} y1={0} y2={height} />
      {rows.map((r, i) => {
        const w = Math.max(2, Math.abs(r.value) * scale);
        const x0 = r.value >= 0 ? zero : zero - w;
        const yy = i * rowH + 4;
        return (
          <g key={r.key}>
            <rect className="hit" x={0} y={yy} width={width} height={rowH}>
              <title>{`${r.name}: ${format(r.value)}`}</title>
            </rect>
            <text x={labelW - 10} y={yy + rowH / 2 + 4} textAnchor="end" style={{ fill: "var(--text)" }}>
              {r.name}
            </text>
            <rect className="mark" x={x0} y={yy + 5} width={w} height={rowH - 10} rx={4} fill={r.value >= 0 ? "var(--pos)" : "var(--neg)"} pointerEvents="none" />
            <text x={plotR + 8} y={yy + rowH / 2 + 4}>
              {format(r.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
