/**
 * 编译期契约检查：不运行，只要 tsc 通过就说明 renderer 能从登记表拿到正确类型。
 */
import type { RoomBridge } from "../src/index";

declare const room: RoomBridge;

export async function typeChecks() {
  const r = await room.command({
    type: "approval.approve",
    approvalId: "apr_01JAAAAAAAAAAAAAAAAAAAAAAA",
    expectedSnapshotHash: "a".repeat(64),
  });
  if (r.ok) {
    const runId: string = r.data.run.id;
    const state: "APPROVED" | "DRAFT" | "READY_FOR_REVIEW" | "REJECTED" | "EXPIRED" | "CANCELLED" = r.data.approval.state;
    void runId, state;
  } else {
    const code: string = r.error;
    void code;
  }

  // @ts-expect-error 缺少 expectedSnapshotHash
  await room.command({ type: "approval.approve", approvalId: "apr_01JAAAAAAAAAAAAAAAAAAAAAAA" });

  // @ts-expect-error 不存在的命令
  await room.command({ type: "fs.rm" });

  const s = await room.query({ type: "system.status" });
  if (s.ok) {
    const configured: boolean = s.data.reviewerConfigured;
    void configured;
  }

  const off = room.onEvent((e) => {
    if (e.type === "run.updated") {
      const st: string = e.run.state;
      void st;
    }
  });
  off();
}
