import type { AgentProfile, BatchModel, ProfileModels, RunModel } from "@room/schemas";

/**
 * 聊天 Run 的模型选择（C-40 的规则，场合 = chat、profile = chatProfileId）。
 *
 * 规则和讨论室一致（见 @room/schemas 的 AgentModelSettings 注释）：
 * 1. 节点没报 profileModels / 没有这个 profile / models 为空 / primaryModel 为 null → null（用 profile 自带）
 * 2. 首选在列表里 → 用首选；否则备选在 → 用备选（usedFallback）
 * 3. 都不在 → 抛 ChatModelUnavailableError（调用方把这个人记成缺席，其他人照常）
 * 4. 强度：配置的档位在这个模型上 → configured；否则节点 defaultEffort → node_default；模型没有档位 → none
 */

export class ChatModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatModelUnavailableError";
  }
}

function modelsOf(profileModels: readonly ProfileModels[] | undefined, profileId: string) {
  return profileModels?.find((profile) => profile.profileId === profileId)?.models;
}

export function selectChatModel(
  agent: AgentProfile,
  profileId: string,
  profileModels: readonly ProfileModels[] | undefined,
  /** 用哪一档强度：回答用 chat，写历史摘要用 summary（D-45） */
  occasion: "chat" | "summary" = "chat",
): BatchModel | null {
  const models = modelsOf(profileModels, profileId);
  if (models === undefined || models.length === 0 || agent.modelSettings.primaryModel === null) return null;

  const primary = models.find((option) => option.id === agent.modelSettings.primaryModel);
  const chosen =
    primary ??
    (agent.modelSettings.fallbackModel === null
      ? undefined
      : models.find((option) => option.id === agent.modelSettings.fallbackModel));
  if (chosen === undefined) {
    const wanted = [agent.modelSettings.primaryModel, agent.modelSettings.fallbackModel]
      .filter((id): id is string => id !== null)
      .join(" / ");
    throw new ChatModelUnavailableError(
      agent.displayName + " 的模型不可用：" + wanted + " 都不在节点上（profile " + profileId + "）",
    );
  }

  let effort: string | null;
  let effortSource: BatchModel["effortSource"];
  if (chosen.efforts.length === 0) {
    effort = null;
    effortSource = "none";
  } else {
    const configured = agent.modelSettings.effort[occasion];
    if (configured !== null && chosen.efforts.some((level) => level.id === configured)) {
      effort = configured;
      effortSource = "configured";
    } else {
      effort = chosen.defaultEffort ?? null;
      effortSource = "node_default";
    }
  }

  return { model: chosen.id, effort, usedFallback: primary === undefined, effortSource };
}

/**
 * 重试：先沿用上一次尝试的模型（节点已经不支持就重选）。
 * previous 为 null 表示上次就是「跟随 profile」，这次也跟（除非节点现在报了列表——那也还是跟，规则同 1）。
 */
export function reuseOrSelectChatModel(
  agent: AgentProfile,
  profileId: string,
  profileModels: readonly ProfileModels[] | undefined,
  previous: BatchModel | null,
): BatchModel | null {
  if (previous === null) return selectChatModel(agent, profileId, profileModels);
  const models = modelsOf(profileModels, profileId);
  if (
    models !== undefined &&
    models.some(
      (option) =>
        option.id === previous.model &&
        (previous.effort === null || option.efforts.some((level) => level.id === previous.effort)),
    )
  ) {
    return previous;
  }
  return selectChatModel(agent, profileId, profileModels);
}

/** 给节点的是 RunModel（去掉只给人看的两个标记） */
export function chatRunModel(model: BatchModel | null): RunModel | undefined {
  return model === null ? undefined : { model: model.model, effort: model.effort };
}
