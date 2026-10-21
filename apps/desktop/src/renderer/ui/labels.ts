import type { ApprovalState, ContributionType, FailureReason, RunState } from "@room/schemas";

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

/** 失败原因 → 用户能看懂、知道下一步怎么办的说明 */
export const FAILURE_REASON_LABEL: Record<FailureReason, string> = {
  interrupted: "应用在评审进行中被关闭，这次评审没有完成。",
  connection_lost: "和执行节点的连接中断，超过等待时间仍未恢复。",
  lease_expired: "执行节点长时间没有收到应用的连接，自行停止了评审。",
  remote_lost: "执行节点已经不认识这次评审（可能重启过）。",
  remote_rejected: "执行节点拒绝了这次请求。",
  hash_mismatch: "发送前校验发现 prompt 与批准时的不一致，已拒绝发送。",
  commit_mismatch: "代码版本与批准时的不一致，已拒绝执行。",
  spawn_failed: "无法启动评审程序。",
  process_exit_nonzero: "评审程序异常退出。",
  output_limit_exceeded: "Reviewer 的输出超过上限，已停止。",
  incomplete_output: "Reviewer 的回复没有正常结束（可能被截断），不能当作完整结果。",
  postprocess: "评审完成了，但保存结果时出错。",
  quota_exhausted: "额度用尽或被限流，这次缺席。",
  internal: "Reviewer 调用出错。",
};

export function formatDuration(fromIso: string, toIso: string): string {
  const sec = Math.max(0, Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const m = Math.floor(sec / 60);
  return `${m} 分 ${sec % 60} 秒`;
}

/** 精确到秒，用于同一分钟内的多次运行能区分开 */
export function formatClock(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
