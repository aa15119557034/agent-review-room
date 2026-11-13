import type { CSSProperties, ReactNode } from "react";
import type { ChartSpec } from "@room/schemas";
import { BAD_CHART_LABEL, splitReply } from "../lib/media";
import { hasMarkup, parseMarkup } from "../lib/markup";

/**
 * 秘书写的 ```room-chart 图表（ADR-004 §5，契约 C-42d）。聊天和讨论室共用。
 * - 只画 parseChartSpec 校验过的；所有文字都当纯文本放进 React 文本节点，不当 HTML / SVG / 链接 / 格式化函数
 * - 自己画 SVG，不引第三方库；没有任何动画（「减少动态效果」下也一样）
 * - 校验不过：原样显示代码块，并提示「图表格式不对」
 */

const W = 320;
const H = 190;
const PAD = { l: 34, r: 8, t: 10, b: 28 };
const color = (i: number): CSSProperties => ({ fill: `var(--chart-${(i % 8) + 1})`, stroke: `var(--chart-${(i % 8) + 1})` });

/** 回答正文：文字段照旧显示，图表块画出来 */
export function ReplyBody({ text, className = "chat-text" }: { text: string; className?: string }) {
  const segments = splitReply(text);
  if (segments.length === 1 && segments[0]!.kind === "text" && !hasMarkup(text)) return <p className={className}>{text}</p>;
  return (
    <div className="reply-body">
      {segments.map((s, i) =>
        s.kind === "text" ? (
          <MarkedText key={i} text={s.text} className={className} />
        ) : s.kind === "chart" ? (
          <ChartView key={i} chart={s.chart} />
        ) : (
          <figure key={i} className="chart chart-bad">
            <figcaption>图表格式不对（{BAD_CHART_LABEL[s.reason] ?? s.reason}），原样显示：</figcaption>
            <pre>{s.raw}</pre>
          </figure>
        ),
      )}
    </div>
  );
}

/**
 * 一段文字：**加粗**、`行内代码`、``` 代码块按样子显示，其余原样（lib/markup.ts，B-03）。
 * 全部是 React 文本节点：不做链接、不放 HTML。
 */
export function MarkedText({ text, className = "chat-text" }: { text: string; className?: string }) {
  return (
    <>
      {parseMarkup(text).map((b, i) =>
        b.kind === "code" ? (
          <pre key={i} className="reply-code">
            {b.text}
          </pre>
        ) : (
          <p key={i} className={className}>
            {b.spans.map((sp, j) => (sp.kind === "bold" ? <strong key={j}>{sp.text}</strong> : sp.kind === "code" ? <code key={j}>{sp.text}</code> : sp.text))}
          </p>
        ),
      )}
    </>
  );
}

export function ChartView({ chart }: { chart: ChartSpec }) {
  return (
    <figure className="chart" aria-label={chart.title ? `图表：${chart.title}` : "图表"}>
      {chart.title && <figcaption>{chart.title}</figcaption>}
      {chart.type === "table" ? <Table columns={chart.columns} rows={chart.rows} /> : <Plot chart={chart} />}
      {chart.type !== "table" && (
        <details className="chart-data">
          <summary>看数据</summary>
          <Table {...asTable(chart)} />
        </details>
      )}
    </figure>
  );
}

type Plotted = Exclude<ChartSpec, { type: "table" }>;

function Plot({ chart }: { chart: Plotted }) {
  if (chart.type === "pie") return <Pie chart={chart} />;
  const legend = chart.series.map((s) => s.name);
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} className="chart-svg" role="img" aria-label={chart.title ?? "图表"}>
        {chart.type === "scatter" ? <Scatter chart={chart} /> : <Categorical chart={chart} />}
      </svg>
      {legend.length > 1 && <Legend names={legend} />}
    </>
  );
}

function Legend({ names }: { names: string[] }) {
  return (
    <ul className="chart-legend">
      {names.map((n, i) => (
        <li key={i}>
          <svg viewBox="0 0 10 10" aria-hidden="true">
            <rect width="10" height="10" rx="2" style={color(i)} />
          </svg>
          {n}
        </li>
      ))}
    </ul>
  );
}

/** 数值轴：包含 0，取几个整齐的刻度 */
function scale(values: number[]) {
  let lo = Math.min(0, ...values);
  let hi = Math.max(0, ...values);
  if (lo === hi) hi = lo + 1;
  const step = niceStep((hi - lo) / 4);
  lo = Math.floor(lo / step) * step;
  hi = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Number(v.toPrecision(12)));
  return { lo, hi, ticks };
}

function niceStep(raw: number) {
  const p = 10 ** Math.floor(Math.log10(raw));
  const f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

const fmt = (v: number) => (Math.abs(v) >= 1e4 || (Math.abs(v) < 1e-3 && v !== 0) ? v.toExponential(1) : String(Number(v.toPrecision(4))));

function Axes({ y, xLabel, yLabel, children }: { y: ReturnType<typeof scale>; xLabel?: string; yLabel?: string; children?: ReactNode }) {
  const yPos = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - y.lo) / (y.hi - y.lo));
  return (
    <g className="chart-axes">
      {y.ticks.map((t) => (
        <g key={t}>
          <line x1={PAD.l} x2={W - PAD.r} y1={yPos(t)} y2={yPos(t)} className={t === 0 ? "chart-zero" : "chart-grid"} />
          <text x={PAD.l - 4} y={yPos(t) + 3} textAnchor="end">
            {fmt(t)}
          </text>
        </g>
      ))}
      {yLabel && (
        <text x={2} y={PAD.t - 1} className="chart-axis-label">
          {yLabel}
        </text>
      )}
      {xLabel && (
        <text x={W - PAD.r} y={H - 2} textAnchor="end" className="chart-axis-label">
          {xLabel}
        </text>
      )}
      {children}
    </g>
  );
}

function Categorical({ chart }: { chart: Extract<ChartSpec, { type: "bar" | "line" }> }) {
  const values = chart.series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  const y = scale(values);
  const yPos = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - y.lo) / (y.hi - y.lo));
  const n = chart.categories.length;
  const band = (W - PAD.l - PAD.r) / n;
  const cx = (i: number) => PAD.l + band * (i + 0.5);
  // 分类太多时只隔几个写一个标签
  const every = Math.ceil(n / 8);
  const labels = chart.categories.map((c, i) =>
    i % every === 0 ? (
      <text key={i} x={cx(i)} y={H - PAD.b + 12} textAnchor="middle">
        {c.length > 8 ? `${c.slice(0, 7)}…` : c}
      </text>
    ) : null,
  );
  if (chart.type === "bar") {
    const k = chart.series.length;
    const bw = Math.max(1, (band * 0.8) / k);
    return (
      <Axes y={y} xLabel={chart.xLabel} yLabel={chart.yLabel}>
        {chart.series.map((s, si) =>
          s.values.map((v, i) =>
            v === null ? null : (
              <rect
                key={`${si}-${i}`}
                x={cx(i) - (band * 0.8) / 2 + si * bw}
                width={bw}
                y={Math.min(yPos(v), yPos(0))}
                height={Math.abs(yPos(v) - yPos(0))}
                style={color(si)}
              >
                <title>{`${s.name} · ${chart.categories[i]}：${v}`}</title>
              </rect>
            ),
          ),
        )}
        {labels}
      </Axes>
    );
  }
  return (
    <Axes y={y} xLabel={chart.xLabel} yLabel={chart.yLabel}>
      {chart.series.map((s, si) => {
        // null 断开折线
        const runs: string[][] = [[]];
        s.values.forEach((v, i) => (v === null ? runs.push([]) : runs[runs.length - 1]!.push(`${cx(i)},${yPos(v)}`)));
        return (
          <g key={si} style={color(si)}>
            {runs.filter((r) => r.length > 1).map((r, j) => (
              <polyline key={j} points={r.join(" ")} className="chart-line" style={{ stroke: `var(--chart-${(si % 8) + 1})` }} />
            ))}
            {s.values.map((v, i) =>
              v === null ? null : (
                <circle key={i} cx={cx(i)} cy={yPos(v)} r={2.5}>
                  <title>{`${s.name} · ${chart.categories[i]}：${v}`}</title>
                </circle>
              ),
            )}
          </g>
        );
      })}
      {labels}
    </Axes>
  );
}

function Scatter({ chart }: { chart: Extract<ChartSpec, { type: "scatter" }> }) {
  const pts = chart.series.flatMap((s) => s.points);
  const y = scale(pts.map((p) => p.y));
  let xlo = Math.min(...pts.map((p) => p.x));
  let xhi = Math.max(...pts.map((p) => p.x));
  if (xlo === xhi) [xlo, xhi] = [xlo - 1, xhi + 1];
  const xPos = (v: number) => PAD.l + 4 + (W - PAD.l - PAD.r - 8) * ((v - xlo) / (xhi - xlo));
  const yPos = (v: number) => PAD.t + (H - PAD.t - PAD.b) * (1 - (v - y.lo) / (y.hi - y.lo));
  return (
    <Axes y={y} xLabel={chart.xLabel} yLabel={chart.yLabel}>
      <text x={PAD.l} y={H - PAD.b + 12}>
        {fmt(xlo)}
      </text>
      <text x={W - PAD.r} y={H - PAD.b + 12} textAnchor="end">
        {fmt(xhi)}
      </text>
      {chart.series.map((s, si) =>
        s.points.map((p, i) => (
          <circle key={`${si}-${i}`} cx={xPos(p.x)} cy={yPos(p.y)} r={3} style={color(si)} className="chart-dot">
            <title>{`${s.name}：(${p.x}, ${p.y})`}</title>
          </circle>
        )),
      )}
    </Axes>
  );
}

function Pie({ chart }: { chart: Extract<ChartSpec, { type: "pie" }> }) {
  const total = chart.slices.reduce((n, s) => n + s.value, 0);
  const r = 70;
  const c = { x: 90, y: 85 };
  let angle = -Math.PI / 2;
  return (
    <>
      <svg viewBox="0 0 180 170" className="chart-svg chart-pie" role="img" aria-label={chart.title ?? "饼图"}>
        {total === 0 ? (
          <circle cx={c.x} cy={c.y} r={r} className="chart-empty" />
        ) : (
          chart.slices.map((s, i) => {
            const a0 = angle;
            const a1 = (angle += (s.value / total) * Math.PI * 2);
            const pt = (a: number) => `${c.x + r * Math.cos(a)},${c.y + r * Math.sin(a)}`;
            const whole = s.value === total;
            return whole ? (
              <circle key={i} cx={c.x} cy={c.y} r={r} style={color(i)} />
            ) : s.value === 0 ? null : (
              <path key={i} d={`M${c.x},${c.y} L${pt(a0)} A${r},${r} 0 ${a1 - a0 > Math.PI ? 1 : 0} 1 ${pt(a1)} Z`} style={color(i)} className="chart-slice">
                <title>{`${s.label}：${s.value}`}</title>
              </path>
            );
          })
        )}
      </svg>
      <ul className="chart-legend">
        {chart.slices.map((s, i) => (
          <li key={i}>
            <svg viewBox="0 0 10 10" aria-hidden="true">
              <rect width="10" height="10" rx="2" style={color(i)} />
            </svg>
            {s.label} {total > 0 ? `${Math.round((s.value / total) * 100)}%` : ""}
          </li>
        ))}
      </ul>
    </>
  );
}

function Table({ columns, rows }: { columns: string[]; rows: (string | number | null)[][] }) {
  return (
    <div className="chart-table-wrap">
      <table className="chart-table">
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((v, j) => (
                <td key={j} data-num={typeof v === "number" || undefined}>
                  {v === null ? "—" : String(v)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 图下面「看数据」的表（读屏和想看准确数字的时候用） */
function asTable(chart: Plotted): { columns: string[]; rows: (string | number | null)[][] } {
  switch (chart.type) {
    case "bar":
    case "line":
      return { columns: [chart.xLabel ?? "", ...chart.series.map((s) => s.name)], rows: chart.categories.map((c, i) => [c, ...chart.series.map((s) => s.values[i] ?? null)]) };
    case "scatter":
      return { columns: ["组", chart.xLabel ?? "x", chart.yLabel ?? "y"], rows: chart.series.flatMap((s) => s.points.map((p) => [s.name, p.x, p.y])) };
    case "pie":
      return { columns: ["", "数值"], rows: chart.slices.map((s) => [s.label, s.value]) };
  }
}
