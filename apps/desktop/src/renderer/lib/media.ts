import {
  AUDIO_URL_SCHEME,
  CHART_FENCE,
  CODEX_DRAW_QUOTA_THRESHOLD_PERCENT,
  IMAGE_URL_SCHEME,
  MEDIA_JOB_TRANSITIONS,
  SPEAK_MAX_CHARS,
  speakableText,
  canTransition,
  parseChartSpec,
  type AgentChatMessage,
  type AgentProfile,
  type ChartSpec,
  type DrawFallbackReason,
  type DrawRoute,
  type DrawRoutePreview,
  type MediaCancelReason,
  type MediaFailureReason,
  type MediaJob,
  type NodeHealth,
  type SubscriptionQuota,
} from "@room/schemas";
import { pickModel } from "./models";

/**
 * 多模态（C-43，契约 C-42a～e）界面用的纯函数：图片 / 音频地址、图表代码块、看图提示、「用语音回」的说法、
 * 媒体任务的合并和文字说明。和其他 lib 一样只看后端给的数据，不推导任务结局。
 */

// ---------------------------------------------------------------- 图片 / 音频地址

/**
 * 真实后端：只用 `room-image://img_…` / `room-audio://aud_…`，路径由 main 映射（C-32、C-42c）。
 * 浏览器里的 mock 没有这两个协议，main.tsx 把 mock 的解析函数装进来（只在 ?mock 时）。
 */
type Resolver = (ref: string) => string | undefined;
let resolver: Resolver | null = null;

export function setMediaResolver(fn: Resolver | null) {
  resolver = fn;
}

export const imageSrc = (ref: string) => resolver?.(ref) ?? `${IMAGE_URL_SCHEME}://${ref}`;
export const audioSrc = (ref: string) => resolver?.(ref) ?? `${AUDIO_URL_SCHEME}://${ref}`;

// ---------------------------------------------------------------- 图表（ADR-004 §5）

export type ReplySegment =
  | { kind: "text"; text: string }
  | { kind: "chart"; chart: ChartSpec }
  /** 校验不过：原样显示成代码块，并提示「图表格式不对」 */
  | { kind: "bad_chart"; raw: string; reason: string };

const FENCE = new RegExp("```" + CHART_FENCE + "[ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n?```", "g");

/** 把回答正文切成文字和 ```room-chart 图表块。没闭合的代码块按文字处理 */
export function splitReply(text: string): ReplySegment[] {
  const out: ReplySegment[] = [];
  let last = 0;
  for (const m of text.matchAll(FENCE)) {
    const before = text.slice(last, m.index);
    if (before.trim()) out.push({ kind: "text", text: before.replace(/^\n+|\n+$/g, "") });
    const raw = m[1] ?? "";
    const r = parseChartSpec(raw);
    out.push(r.ok ? { kind: "chart", chart: r.chart } : { kind: "bad_chart", raw, reason: r.reason });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last);
  if (rest.trim() || out.length === 0) out.push({ kind: "text", text: out.length ? rest.replace(/^\n+/, "") : rest });
  return out;
}

/** 正文里有没有图表块（讨论室的发言 / 汇总也能用，ADR-004 §5） */
export const hasChart = (text: string) => text.includes("```" + CHART_FENCE);

/** 预览、引用里显示的一行：图表块换成「[图表]」 */
export const stripCharts = (text: string) => text.replace(FENCE, "[图表]");

export const BAD_CHART_LABEL: Record<string, string> = {
  too_large: "数据太大",
  not_json: "不是合法的 JSON",
  too_deep: "嵌套太深",
  invalid: "字段不合格式",
};

// ---------------------------------------------------------------- 看图提示（ADR-004 §2「聊天里也提醒」）

/**
 * 这位秘书现在用的聊天模型能不能看你发的图。只是提示，后端照 C-42a 自己判断：
 * - yes           ：能看
 * - no            ：模型看不了（或 profile 有模型列表却没选模型，这时不能带图）
 * - unknown       ：节点还没实测
 * - no_attachments：节点没报 capabilities.attachments（老节点），一律收不到图
 * - offline       ：没配聊天 / 连不上节点，不知道
 * 不是 yes 的人都只收到「[图片：文件名]」
 */
export type VisionHint = "yes" | "no" | "unknown" | "no_attachments" | "offline";

export function chatVision(agent: AgentProfile, health: NodeHealth | null | undefined): VisionHint {
  if (!health || agent.chatProfileId === null) return "offline";
  if (!health.capabilities?.attachments) return "no_attachments";
  const pm = health.profileModels?.find((p) => p.profileId === agent.chatProfileId);
  if (!pm) return "unknown";
  if (pm.models.length === 0) return pm.fixedModelVision ?? "unknown";
  const picked = pickModel(agent.modelSettings, pm.models, "chat");
  if (!picked.ok) return "unknown";
  if (picked.model === null) return "no";
  return pm.models.find((m) => m.id === picked.model!.model)?.vision ?? "unknown";
}

export const VISION_LABEL: Record<Exclude<VisionHint, "yes">, string> = {
  no: "看不了图",
  unknown: "还没测过能不能看图",
  no_attachments: "节点还不能收图",
  offline: "连不上节点，不知道能不能看图",
};

/** 输入框上的提示：这条带图时，哪几位（当前模型）看不到，例如「林离（当前模型）看不了图」 */
export function visionWarnings(
  recipients: readonly string[],
  vision: Readonly<Record<string, VisionHint>>,
  name: (agent: string) => string,
): string[] {
  return recipients
    .map((a) => [a, vision[a] ?? "offline"] as const)
    .filter(([, v]) => v !== "yes")
    .map(([a, v]) => `${name(a)}（当前模型）${VISION_LABEL[v as Exclude<VisionHint, "yes">]}，只会收到「[图片：文件名]」`);
}

// ---------------------------------------------------------------- 用语音回（ADR-004 §4）

/**
 * 你正在发的这一条里有没有「用语音回我」这类说法。只看你正在打的这一条（不看历史、引用、附件），
 * 认出来就自动点亮开关，你发送前看得到也能关
 */
const VOICE_REPLY = /用语音(回|答|说|讲)|语音(回|回复|回答)我|(发|回)(我)?(一?[条段个])?语音|说给我听|念给我听|读给我听|讲给我听/;
export const asksForVoiceReply = (text: string) => VOICE_REPLY.test(text);

// ---------------------------------------------------------------- 媒体任务

/** 新的任务记录能不能覆盖旧的（命令返回和事件可能乱序）：状态相同，或按 MEDIA_JOB_TRANSITIONS 能走过去 */
export const jobIsNewer = (old: MediaJob, next: MediaJob) =>
  old.state === next.state || canTransition(MEDIA_JOB_TRANSITIONS, old.state, next.state);

export function mergeJobs(existing: readonly MediaJob[], incoming: readonly MediaJob[]): MediaJob[] {
  const out = existing.slice();
  for (const j of incoming) {
    const i = out.findIndex((x) => x.id === j.id);
    if (i === -1) out.push(j);
    else if (jobIsNewer(out[i]!, j)) out[i] = j;
  }
  return out;
}

export const jobActive = (j: MediaJob) => j.state === "queued" || j.state === "running";

/** 一条消息的媒体任务，按创建时间正序 */
export const jobsOf = (jobs: readonly MediaJob[], messageId: string, kind?: MediaJob["kind"]) =>
  jobs
    .filter((j) => j.source.kind === "chat" && j.source.messageId === messageId && (kind === undefined || j.kind === kind))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));

/**
 * 秘书回答下面的画图请求卡要不要显示（mediaIntent.draw 存在时）：
 * - 有一个还没结束或者画成了的任务 → 不显示卡片，显示任务本身
 * - 沉浸模式自动画的任务因为显卡排队超时 / 本机没开失败了 → 退回成卡片（ADR-004 §3a）
 * - 最近一次是林离额度用完失败 → 不显示卡片，失败那行有「改用本机画」，一处入口，不会一下建两个任务
 * - 其余（关着沉浸模式、超过每小时上限、你取消了、失败了）→ 显示卡片，可以再点「画」
 */
export function showDrawCard(m: AgentChatMessage, jobs: readonly MediaJob[]): boolean {
  if (!m.mediaIntent?.draw) return false;
  const draws = jobsOf(jobs, m.id, "draw");
  if (draws.some((j) => jobActive(j) || j.state === "succeeded")) return false;
  const last = draws.at(-1);
  return !(last && canRetryLocally(last));
}

export const JOB_STATE_LABEL: Record<MediaJob["state"], string> = {
  queued: "排队中",
  running: "正在生成",
  succeeded: "好了",
  failed: "失败",
  cancelled: "已取消",
  timed_out: "超时",
};

export const FAILURE_LABEL: Record<MediaFailureReason, string> = {
  backend_unavailable: "林离和本机都用不了",
  quota_exhausted: "画到一半林离的额度用完了",
  generation_failed: "生成出错",
  artifact_invalid: "取回的图不对（校验没过）",
  gpu_queue_timeout: "显卡排队超过 2 分钟",
  internal: "内部错误",
};

export const CANCEL_LABEL: Record<MediaCancelReason, string> = {
  user_cancel: "你取消了",
  user_stop: "你点了「停」",
  immersive_off: "关掉了沉浸模式",
  message_withdrawn: "消息撤回了",
  superseded: "回答重新生成了",
  app_restart: "应用重启了",
};

export const FALLBACK_LABEL: Record<DrawFallbackReason, string> = {
  quota_threshold: `林离额度到了 ${CODEX_DRAW_QUOTA_THRESHOLD_PERCENT}%`,
  quota_unknown: "读不到林离的额度",
  credits_in_use: "林离已经在用付费 credits",
  codex_unavailable: "林离那边现在用不了",
  session_local_only: "这个会话设了自动画图只用本机",
};

/** 额度的一句话：「5 小时 42%、每周 18%」；读不到的窗口写「读不到」 */
export function quotaText(q: SubscriptionQuota | null): string {
  if (!q) return "额度读不到";
  const w = (label: string, x: SubscriptionQuota["fiveHour"]) => `${label} ${x ? `${Math.round(x.usedPercent)}%` : "读不到"}`;
  return [w("5 小时", q.fiveHour), w("每周", q.weekly), ...(q.creditsInUse ? ["在用 credits"] : [])].join("、");
}

/** 请求卡上「这次会走哪条路」 */
export function routePreviewText(p: DrawRoutePreview): string {
  if (p.backend === "codex") return `会用林离的订阅（${quotaText(p.quota)}）`;
  if (p.backend === "comfyui") return `会用本机画${p.fallbackReason ? `，因为${FALLBACK_LABEL[p.fallbackReason]}` : ""}`;
  return `现在画不了：${p.fallbackReason ? FALLBACK_LABEL[p.fallbackReason] : "林离用不了"}，本机也没开`;
}

/** 画好的图下面的来历：「林离画的（画前 5 小时 42%…）」或「本机画的，因为……」 */
export function routeText(r: DrawRoute): string {
  if (r.backend === "codex") return `林离画的${r.manual ? "（你指定的）" : ""} · 画前：${quotaText(r.quotaBefore)}`;
  const why = r.fallbackReason ? `，本来想用林离，因为${FALLBACK_LABEL[r.fallbackReason]}改用本机` : r.manual ? "（你指定的）" : "";
  return `本机画的${why}`;
}

/** 失败 / 取消的一句话 */
export function jobEndText(j: MediaJob): string {
  if (j.state === "failed" && j.failure) return `${JOB_STATE_LABEL.failed}：${FAILURE_LABEL[j.failure.reason]}`;
  if (j.state === "cancelled" && j.cancelReason) return `${JOB_STATE_LABEL.cancelled}（${CANCEL_LABEL[j.cancelReason]}）`;
  return JOB_STATE_LABEL[j.state];
}

/** 失败后能不能「改用本机画」：林离画到一半额度用完（ADR-004 §3，不自动重画） */
export const canRetryLocally = (j: MediaJob) => j.kind === "draw" && j.state === "failed" && j.failure?.reason === "quota_exhausted";

/** 手动选林离时的按钮状态（契约 DrawRoutePreview.codexManual） */
export const CODEX_MANUAL_LABEL: Record<DrawRoutePreview["codexManual"], string | null> = {
  none: null,
  confirm: `林离额度已经 ≥ ${CODEX_DRAW_QUOTA_THRESHOLD_PERCENT}% 或读不到，确定还用林离就再点一次`,
  blocked: "林离额度已经用满或在用 credits，不能选",
};

// ---------------------------------------------------------------- 语音

/** 能不能念：和 main 判 speak、speech.play、D-37b 合成用同一个 speakableText（C-42e），不另算 */
export function canSpeak(text: string): boolean {
  const n = speakableText(text).length;
  return n > 0 && n <= SPEAK_MAX_CHARS;
}

export function durationText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}″` : `${Math.floor(s / 60)}′${String(s % 60).padStart(2, "0")}″`;
}

/** 录音时长条的宽度（微信那样随时长变长，有上下限） */
export const voiceBubbleWidth = (ms: number) => `${Math.min(14, 5 + Math.sqrt(ms / 1000) * 1.6).toFixed(1)}em`;
