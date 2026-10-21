import type { AgentPatch } from "./discussion-actions";

/**
 * 推荐配置（C-27）：Claude 在用户电脑上，Codex 和 DeepSeek 在主控机本机节点上（S-10）。
 * 角色设定只写分工、不写性格：越短越不容易把讨论带偏（2026-10-21 和用户商定）。
 */

export const USER_PC_NODE = "user-pc";
export const CONTROLLER_NODE = "controller-local";

export const RECOMMENDED_NODES: readonly { id: string; label: string; baseUrl: string | null; hint: string }[] = [
  { id: USER_PC_NODE, label: "你的电脑", baseUrl: null, hint: "Claude 所在的电脑。地址和 Token 来自上面的「Reviewer 节点」，已自动迁移" },
  {
    id: CONTROLLER_NODE,
    label: "主控机（本机）",
    baseUrl: "http://127.0.0.1:7420",
    hint: "Codex 和 DeepSeek 所在的这台电脑。Token 是本机运行 run setup -- --local 时显示的那个",
  },
];

export const RECOMMENDED_AGENTS: readonly (AgentPatch & { displayName: string; color: string })[] = [
  {
    id: "claude",
    displayName: "C酱",
    color: "#a0522d",
    roleNote: "从整体设计、接口规则和风险的角度看问题，负责汇总。",
    canDiscuss: true,
    canSummarize: true,
    nodeId: USER_PC_NODE,
    profileId: "claude-review",
  },
  {
    id: "deepseek",
    displayName: "DeepSeek",
    color: "#2f5aa0",
    roleNote: "从工程上能不能做、要多大工作量、怎么拆的角度看问题。",
    canDiscuss: true,
    canSummarize: false,
    nodeId: CONTROLLER_NODE,
    profileId: "deepseek-discuss",
  },
  {
    id: "codex",
    displayName: "Codex",
    color: "#1f6b55",
    roleNote: "从代码、测试和边界情况的角度，挑实现上的毛病。",
    canDiscuss: true,
    canSummarize: false,
    nodeId: CONTROLLER_NODE,
    profileId: "codex-discuss",
  },
];
