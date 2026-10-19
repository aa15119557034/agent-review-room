import type { ApprovalState, ContributionType, RunState } from "@room/schemas";

/** 界面上的中文名称集中在这里，保证同一个东西在各处叫法一致 */

export const RUN_STATE_LABEL: Record<RunState, string> = {
  QUEUED: "排队中",
  STARTING: "启动中",
  RUNNING: "评审中",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELLED: "已取消",
  TIMED_OUT: "超时",
};

export const APPROVAL_STATE_LABEL: Record<ApprovalState, string> = {
  DRAFT: "草稿",
  READY_FOR_REVIEW: "等待批准",
  APPROVED: "已批准",
  REJECTED: "已退回",
  EXPIRED: "已失效",
  CANCELLED: "已撤销",
};

export const CONTRIBUTION_TYPE_LABEL: Record<ContributionType, string> = {
  proposal: "方案",
  issue: "问题",
  risk: "风险",
  counterexample: "反例",
  correction: "修正",
  implementation: "实现",
  review: "评审",
  decision_candidate: "待定决策",
  test_result: "测试结果",
  evidence: "依据",
  open_question: "未解决问题",
};

/** 状态的视觉分组，对应 CSS 里的 data-tone */
export function runTone(state: RunState): "quiet" | "active" | "good" | "bad" {
  if (state === "COMPLETED") return "good";
  if (state === "FAILED" || state === "TIMED_OUT") return "bad";
  if (state === "CANCELLED") return "quiet";
  return "active";
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
