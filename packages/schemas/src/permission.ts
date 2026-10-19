import { z } from "zod";
import { IsoTimestamp, PermissionRequestId } from "./common";

export const PermissionKind = z.enum(["file_write", "command", "tool", "network", "other"]);

export const PermissionRequest = z.object({
  requestId: PermissionRequestId,
  kind: PermissionKind,
  /** 给人看的一句话说明。来自 Agent，属于不可信数据，UI 必须按纯文本显示。 */
  summary: z.string().max(2000),
  detail: z.record(z.string(), z.unknown()).default({}),
  requestedAt: IsoTimestamp,
});

export const PermissionDecision = z.object({
  decision: z.enum(["allow_once", "deny"]),
  /** system = 超时、取消、断线等自动拒绝 */
  decidedBy: z.enum(["human", "system"]),
  reason: z.string().max(500).optional(),
});

export type PermissionRequest = z.infer<typeof PermissionRequest>;
export type PermissionDecision = z.infer<typeof PermissionDecision>;
