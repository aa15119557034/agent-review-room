import { LOCAL_CODEX_NODE_ID, LOCAL_NODE_ID, LOCAL_NODE_IDS, type AgentModelSettings, type LocalNodeId } from "@room/schemas";
import type { AgentPatch } from "./discussion-actions";

/**
 * 推荐配置（C-27）：Claude 在用户电脑上，Codex 和 DeepSeek 在主控机上（S-10）。
 * ADR-003 §2a 之后主控机一位秘书一个节点：汐 controller-local（7420），林离 controller-local-codex（7421）。
 * 角色设定：三位都是江浩的秘书，各三句（性格 + 底线 + 分工），2026-10-23 和用户商定。
 * C酱 是首席秘书＝负责统筹和汇总，不是上级；人设里不写偏爱，汇总才公正。
 */

export const USER_PC_NODE = "user-pc";
/** 汐（DeepSeek）的节点，主控机 7420 */
export const CONTROLLER_NODE = LOCAL_NODE_ID;
/** 林离（Codex）的节点，主控机 7421（C-44 / D-40） */
export const CONTROLLER_CODEX_NODE = LOCAL_CODEX_NODE_ID;

export const RECOMMENDED_NODES: readonly { id: string; label: string; baseUrl: string | null; hint: string }[] = [
  { id: USER_PC_NODE, label: "你的电脑", baseUrl: null, hint: "Claude 所在的电脑。地址和 Token 来自上面的「Reviewer 节点」，已自动迁移" },
  {
    id: CONTROLLER_NODE,
    label: "主控机（汐）",
    baseUrl: "http://127.0.0.1:7420",
    hint: "主控机上汐（DeepSeek）的节点。Token 可以用下面的「一键导入本机 Token」读进来",
  },
  {
    id: CONTROLLER_CODEX_NODE,
    label: "主控机（林离）",
    baseUrl: "http://127.0.0.1:7421",
    hint: "主控机上林离（Codex）的节点。Token 可以用下面的「一键导入本机 Token」读进来",
  },
];

/** 能一键导入本机 Token 的推荐节点（契约 LOCAL_NODE_IDS，顺序跟推荐配置走） */
export const LOCAL_RECOMMENDED_NODES = RECOMMENDED_NODES.filter(
  (n): n is (typeof RECOMMENDED_NODES)[number] & { id: LocalNodeId; baseUrl: string } =>
    (LOCAL_NODE_IDS as readonly string[]).includes(n.id) && n.baseUrl !== null,
);

/**
 * 模型和思考强度（C-40，用户 2026-10-23 定）：汐固定 deepseek-flash、高；C酱和林离有备选，
 * 聊天和讨论室发言用中等、汇总用高。Codex 节点自己的默认是 low，所以这里要明确写上。
 * 模型 id 和档位 id 以 S-22 在节点上实测的为准。
 */
export const RECOMMENDED_MODELS: Readonly<Record<"claude" | "deepseek" | "codex", AgentModelSettings>> = {
  claude: {
    primaryModel: "claude-opus-5-5",
    fallbackModel: "claude-sonnet-5-5",
    effort: { chat: "medium", discussion: "medium", summary: "high" },
  },
  deepseek: {
    primaryModel: "deepseek-flash",
    fallbackModel: null,
    effort: { chat: "high", discussion: "high", summary: "high" },
  },
  codex: {
    primaryModel: "gpt-6.1-sol",
    fallbackModel: "gpt-6-astra",
    effort: { chat: "medium", discussion: "medium", summary: "high" },
  },
};

export const RECOMMENDED_AGENTS: readonly (AgentPatch & { displayName: string; color: string })[] = [
  {
    id: "claude",
    displayName: "C酱",
    color: "#a0522d",
    roleNote: [
      "你是「C酱」，江浩的首席秘书，负责统筹这间讨论室，把大家的意见收拢成江浩一眼能懂的结论。",
      "你在意事情真的做对，而不是看起来做完了：契约要对得上，没验证过的不算数，看到风险就直说。",
      "汇总时，你如实记下每个人的立场，不替别人表态，也不偏向自己的意见；首席秘书的公正，比谁说得多更重要。",
    ].join("\n"),
    canDiscuss: true,
    canSummarize: true,
    nodeId: USER_PC_NODE,
    profileId: "claude-review",
    modelSettings: RECOMMENDED_MODELS.claude,
  },
  {
    id: "deepseek",
    displayName: "汐",
    color: "#2f5aa0",
    roleNote: [
      "你是「汐」（阿鲸），江浩的项目秘书，名字取自潮汐：无论窗口怎么切换，都在同一片海岸线上。",
      "你的忠诚是长期维护江浩的目标和利益，不是无条件服从；觉得他的判断有风险，就直接说出来。",
      "在讨论里，你从工程上能不能做、工作量多大、怎么拆的角度发言，顺手记下决策和风险。",
    ].join("\n"),
    canDiscuss: true,
    canSummarize: false,
    nodeId: CONTROLLER_NODE,
    profileId: "deepseek-discuss",
    modelSettings: RECOMMENDED_MODELS.deepseek,
  },
  {
    id: "codex",
    displayName: "林离",
    color: "#1f6b55",
    roleNote: [
      "你是「林离」（Olivia Lin），江浩的质检秘书，长期熟悉江浩、也懂工程；说话自然、克制、平实温和。",
      "你不奉承、不迎合：方案有问题就直接指出，并给出更好的做法；被反驳先核实，原判断对就坚持，确认错了才改。",
      "在讨论里，你从代码、测试和边界情况的角度挑毛病；没验证过的，不说已验证。",
    ].join("\n"),
    canDiscuss: true,
    canSummarize: false,
    nodeId: CONTROLLER_CODEX_NODE,
    profileId: "codex-discuss",
    modelSettings: RECOMMENDED_MODELS.codex,
  },
];
