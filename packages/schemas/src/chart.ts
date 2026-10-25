import { z } from "zod";

/**
 * 图表（C-42d，ADR-004 §5，阶段 1B-M1）。
 *
 * 秘书在回答里写一段 ```room-chart 代码块，里面是 JSON；应用用 parseChartSpec 校验后自己画。
 * - 图表 JSON 仍然是秘书的发言，按不可信内容处理
 * - 严格白名单：所有对象 strict，多一个字段就不合格；校验不过就原样显示成代码块，并提示「图表格式不对」
 * - renderer 只把文字当纯文本：不当 HTML / SVG / 格式化函数 / 链接 / 事件参数用；数字只当数字
 * - 不支持任意 HTML / SVG / 脚本、外链数据
 */

export const CHART_FENCE = "room-chart";

export const CHART_LIMITS = {
  /** 整段 JSON 的字节数（UTF-8） */
  maxJsonBytes: 64 * 1024,
  /** JSON 嵌套深度（对象 / 数组层数） */
  maxDepth: 6,
  /** 数据组（series） */
  maxSeries: 8,
  /** 合计点数：柱状 / 折线 = 组数 × 分类数；散点 = 所有点；饼图 = 块数；表格 = 单元格数 */
  maxPoints: 500,
  titleMaxChars: 120,
  labelMaxChars: 80,
  cellMaxChars: 200,
  maxCategories: 100,
  maxPieSlices: 20,
  maxTableColumns: 12,
} as const;

const Title = z.string().max(CHART_LIMITS.titleMaxChars);
const Label = z.string().min(1).max(CHART_LIMITS.labelMaxChars);
const Num = z.number().finite();

const SeriesValues = z.object({ name: Label, values: z.array(Num.nullable()) }).strict();

const Categorical = <T extends "bar" | "line">(type: T) =>
  z
    .object({
      type: z.literal(type),
      title: Title.optional(),
      xLabel: Label.optional(),
      yLabel: Label.optional(),
      categories: z.array(Label).min(1).max(CHART_LIMITS.maxCategories),
      series: z.array(SeriesValues).min(1).max(CHART_LIMITS.maxSeries),
    })
    .strict();

export const BarChart = Categorical("bar");
export const LineChart = Categorical("line");

export const ScatterChart = z
  .object({
    type: z.literal("scatter"),
    title: Title.optional(),
    xLabel: Label.optional(),
    yLabel: Label.optional(),
    series: z
      .array(z.object({ name: Label, points: z.array(z.object({ x: Num, y: Num }).strict()).min(1) }).strict())
      .min(1)
      .max(CHART_LIMITS.maxSeries),
  })
  .strict();

/** 饼图没有坐标轴 */
export const PieChart = z
  .object({
    type: z.literal("pie"),
    title: Title.optional(),
    slices: z.array(z.object({ label: Label, value: Num.nonnegative() }).strict()).min(1).max(CHART_LIMITS.maxPieSlices),
  })
  .strict();

export const TableChart = z
  .object({
    type: z.literal("table"),
    title: Title.optional(),
    columns: z.array(Label).min(1).max(CHART_LIMITS.maxTableColumns),
    rows: z.array(z.array(z.union([z.string().max(CHART_LIMITS.cellMaxChars), Num, z.null()]))).min(1),
  })
  .strict();

export const chartPoints = (c: z.infer<typeof ChartSpecBase>): number => {
  switch (c.type) {
    case "bar":
    case "line":
      return c.series.length * c.categories.length;
    case "scatter":
      return c.series.reduce((n, s) => n + s.points.length, 0);
    case "pie":
      return c.slices.length;
    case "table":
      return c.rows.length * c.columns.length;
  }
};

const ChartSpecBase = z.discriminatedUnion("type", [BarChart, LineChart, ScatterChart, PieChart, TableChart]);

export const ChartSpec = ChartSpecBase.superRefine((c, ctx) => {
  if ((c.type === "bar" || c.type === "line") && c.series.some((s) => s.values.length !== c.categories.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "每组的数值个数要和分类数一样" });
  }
  if (c.type === "table" && c.rows.some((r) => r.length !== c.columns.length)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "每行的格子数要和列数一样" });
  }
  if (chartPoints(c) > CHART_LIMITS.maxPoints) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `合计点数超过 ${CHART_LIMITS.maxPoints}` });
  }
});
export type ChartSpec = z.infer<typeof ChartSpec>;

/** 嵌套是否超过 max 层。用显式栈不递归：几万层的 [[[…]]] 也不会把调用栈撑爆 */
const deeperThan = (root: unknown, max: number): boolean => {
  const stack: Array<[unknown, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [v, d] = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    if (d + 1 > max) return true;
    for (const x of Object.values(v as Record<string, unknown>)) stack.push([x, d + 1]);
  }
  return false;
};

/**
 * 解析 ```room-chart 代码块的原文。先查字节数，再 JSON.parse，再查深度，最后按 ChartSpec 校验。
 * 不合格返回 ok: false（界面原样显示代码块）
 */
export function parseChartSpec(raw: string): { ok: true; chart: ChartSpec } | { ok: false; reason: string } {
  if (new TextEncoder().encode(raw).length > CHART_LIMITS.maxJsonBytes) return { ok: false, reason: "too_large" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "not_json" };
  }
  if (deeperThan(value, CHART_LIMITS.maxDepth)) return { ok: false, reason: "too_deep" };
  const r = ChartSpec.safeParse(value);
  return r.success ? { ok: true, chart: r.data } : { ok: false, reason: "invalid" };
}
