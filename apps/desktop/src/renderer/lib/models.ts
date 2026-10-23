import type { AgentModelSettings, BatchModel, EffortLevel, ModelOption, NodeHealth, RunOccasion } from "@room/schemas";

/**
 * 模型选择（C-40 / C-41）。挑选规则照 AgentModelSettings 的注释：
 * 真实后端由 main 来挑（D-35），这里给 mock 和界面共用，界面只用来预览、不代替后端的结果。
 */

/** 节点为某个 profile 上报的模型；undefined = 节点没报（老节点、连不上）或没有这个 profile */
export function modelsFor(health: NodeHealth | null | undefined, profileId: string | null): ModelOption[] | undefined {
  if (!health?.profileModels || profileId === null) return undefined;
  return health.profileModels.find((p) => p.profileId === profileId)?.models;
}

export type PickResult = { ok: true; model: BatchModel | null } | { ok: false; message: string };

export function pickModel(
  settings: AgentModelSettings,
  models: readonly ModelOption[] | undefined,
  occasion: RunOccasion,
  /** 重试 / 恢复：原来那个 Turn 的模型。还能用就沿用 */
  previous?: BatchModel | null,
): PickResult {
  if (previous && models?.some((m) => m.id === previous.model && hasEffort(m, previous.effort))) {
    return { ok: true, model: previous };
  }
  // 1. 跟随 profile 自带的模型
  if (!models || models.length === 0 || settings.primaryModel === null) return { ok: true, model: null };
  // 2 / 3. 首选，否则备选
  const primary = models.find((m) => m.id === settings.primaryModel);
  const fallback = settings.fallbackModel === null ? undefined : models.find((m) => m.id === settings.fallbackModel);
  const chosen = primary ?? fallback;
  // 4. 都不可用
  if (!chosen) {
    const names = [settings.primaryModel, settings.fallbackModel].filter((x) => x !== null).join("、");
    return { ok: false, message: `节点上没有 ${names}` };
  }
  return { ok: true, model: { ...effortFor(chosen, settings.effort[occasion]), model: chosen.id, usedFallback: !primary } };
}

function hasEffort(m: ModelOption, effort: string | null): boolean {
  return effort === null ? m.efforts.length === 0 : m.efforts.some((e) => e.id === effort);
}

function effortFor(m: ModelOption, wanted: string | null): Pick<BatchModel, "effort" | "effortSource"> {
  if (m.efforts.length === 0) return { effort: null, effortSource: "none" };
  if (wanted !== null && m.efforts.some((e) => e.id === wanted)) return { effort: wanted, effortSource: "configured" };
  return { effort: m.defaultEffort, effortSource: "node_default" };
}

/** 确认页、资料页上显示的名字；节点没报时退回 id */
export function modelLabel(models: readonly ModelOption[] | undefined, id: string): string {
  return models?.find((m) => m.id === id)?.displayName ?? id;
}

export function effortLabel(models: readonly ModelOption[] | undefined, modelId: string, effort: string | null): string {
  if (effort === null) return "无强度档位";
  const level: EffortLevel | undefined = models?.find((m) => m.id === modelId)?.efforts.find((e) => e.id === effort);
  return level?.displayName ?? effort;
}

export const OCCASIONS: readonly { id: RunOccasion; label: string }[] = [
  { id: "chat", label: "聊天" },
  { id: "discussion", label: "讨论室发言" },
  { id: "summary", label: "汇总" },
];
