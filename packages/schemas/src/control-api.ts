import { z } from "zod";
import { ApprovalId, PermissionRequestId, RunId, Sha256Hex, SnapshotId } from "./common";
import { NodeHealth, ProfileId } from "./remote-protocol";
import { AgentEvent } from "./agent-event";
import { PermissionDecision, PermissionRequest } from "./permission";
import {
  AgentName,
  Approval,
  Contribution,
  ContributionId,
  ContributionType,
  Message,
  MessageId,
  Project,
  ProjectId,
  PromptSnapshot,
  Run,
  SystemStatus,
  TextSelection,
} from "./entities";

/**
 * 控制面 API：人 ⇄ Orchestrator。
 *
 * - 桌面 renderer 今天通过 Electron IPC 使用（见 ipc.ts）；以后手机 App 通过网络网关使用同一套格式
 * - 手机 App 只连 Orchestrator，**永远不直接连 AgentServer**
 * - 与传输层无关：这里只定义消息格式、返回格式和所需权限
 *
 * 每个命令 / 查询都登记在 COMMANDS / QUERIES 里：request schema、response schema、所需 scope。
 * main 进程按登记表校验入参和出参；renderer 的类型从登记表推导。
 */

export const ClientKind = z.enum(["desktop", "mobile"]);
export type ClientKind = z.infer<typeof ClientKind>;

export const ControlScope = z.enum([
  "read",       // 看状态、看 prompt、看结果
  "author",     // 创建项目、粘贴输入、标记 Contribution、生成 Snapshot
  "approve",    // 批准 / 拒绝
  "permission", // 回答 Agent 的权限请求
  "cancel",     // 取消 run
  "admin",      // 修改设置（Reviewer 节点地址、Token）
]);
export type ControlScope = z.infer<typeof ControlScope>;

// ================================================================ Reviewer 节点设置（ADR-001 物理分离）

/**
 * 主控端连接 AgentServer 的地址，例如 http://192.168.1.20:7420 。
 * 只允许 http / https，不带路径、查询参数和账号信息。
 */
export const NodeBaseUrl = z
  .string()
  .max(200)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === "http:" || u.protocol === "https:") && !u.username && !u.password &&
        (u.pathname === "/" || u.pathname === "") && !u.search && !u.hash;
    } catch {
      return false;
    }
  }, "需要形如 http://192.168.1.20:7420 的地址");

/**
 * AgentServer 的 Token。只能写入，永远不会从后端读出来（查询只返回 tokenConfigured）。
 * main 进程收到后存进系统凭据库（Electron safeStorage），不落 SQLite、不进日志。
 */
export const NodeToken = z.string().min(32).max(512).regex(/^[\x21-\x7e]+$/, "Token 只能包含可见 ASCII 字符");

export const ReviewerNodeSettings = z.object({
  baseUrl: NodeBaseUrl,
  profileId: ProfileId,
  tokenConfigured: z.boolean(),
});
export type ReviewerNodeSettings = z.infer<typeof ReviewerNodeSettings>;

export const NodeTestResult = z.discriminatedUnion("reachable", [
  z.object({
    reachable: z.literal(true),
    health: NodeHealth,
    /** 填写的 profileId 是否在节点上存在 */
    profileAvailable: z.boolean(),
    latencyMs: z.number().int().nonnegative(),
  }),
  z.object({
    reachable: z.literal(false),
    error: z.enum(["unreachable", "timeout", "unauthorized", "protocol_mismatch", "no_token"]),
    message: z.string(),
  }),
]);
export type NodeTestResult = z.infer<typeof NodeTestResult>;

// ================================================================ Commands

const def = <Req extends z.ZodTypeAny, Res extends z.ZodTypeAny>(
  request: Req,
  response: Res,
  scope: ControlScope,
) => ({ request, response, scope });

export const COMMANDS = {
  "project.create": def(
    z.object({ type: z.literal("project.create"), name: z.string().min(1).max(200) }),
    Project,
    "author",
  ),

  /** AC-1：手动粘贴 Source Agent 输出 */
  "source.add": def(
    z.object({
      type: z.literal("source.add"),
      projectId: ProjectId,
      sourceAgent: AgentName,
      content: z.string().min(1).max(2_000_000),
    }),
    Message,
    "author",
  ),

  /** AC-2：选中一段标记成 Contribution。不提交 content，由后端按 selection 截取 */
  "contribution.create": def(
    z.object({
      type: z.literal("contribution.create"),
      projectId: ProjectId,
      sourceMessageId: MessageId,
      contributionType: ContributionType,
      title: z.string().min(1).max(200),
      selection: TextSelection,
    }),
    Contribution,
    "author",
  ),

  /**
   * AC-3/4/5：生成不可变 Snapshot，同时创建一个 READY_FOR_REVIEW 的 Approval。
   * 同一项目中之前处于 READY_FOR_REVIEW / APPROVED 且尚未产生 Run 的 Approval 会变成 EXPIRED。
   */
  "snapshot.create": def(
    z.object({
      type: z.literal("snapshot.create"),
      projectId: ProjectId,
      contributionIds: z.array(ContributionId).min(1).max(100),
      taskInstruction: z.string().min(1).max(20_000),
    }),
    z.object({ snapshot: PromptSnapshot, approval: Approval }),
    "author",
  ),

  /**
   * AC-6：批准并立即创建 Run。
   * expectedSnapshotHash 必须等于 snapshot.contentHash，否则返回 stale_snapshot——
   * 防止停留在旧页面（尤其是手机上）的人批准了已经变化的 prompt。
   */
  "approval.approve": def(
    z.object({
      type: z.literal("approval.approve"),
      approvalId: ApprovalId,
      expectedSnapshotHash: Sha256Hex,
    }),
    z.object({ approval: Approval, run: Run }),
    "approve",
  ),

  "approval.reject": def(
    z.object({
      type: z.literal("approval.reject"),
      approvalId: ApprovalId,
      reason: z.string().max(2000).optional(),
    }),
    Approval,
    "approve",
  ),

  "run.cancel": def(
    z.object({ type: z.literal("run.cancel"), runId: RunId, reason: z.string().max(500).optional() }),
    Run,
    "cancel",
  ),

  /** Phase 0 的 Reviewer 走 API，不会产生权限请求；先占位 */
  "permission.decide": def(
    z.object({
      type: z.literal("permission.decide"),
      runId: RunId,
      requestId: PermissionRequestId,
      decision: PermissionDecision.shape.decision,
    }),
    z.object({}),
    "permission",
  ),

  /** 保存 Reviewer 节点设置。token 不传表示保留原来的 */
  "settings.updateReviewerNode": def(
    z.object({
      type: z.literal("settings.updateReviewerNode"),
      baseUrl: NodeBaseUrl,
      profileId: ProfileId,
      token: NodeToken.optional(),
    }),
    ReviewerNodeSettings,
    "admin",
  ),

  /** 测试连接（不保存）。token 不传则使用已保存的 */
  "settings.testReviewerNode": def(
    z.object({
      type: z.literal("settings.testReviewerNode"),
      baseUrl: NodeBaseUrl,
      profileId: ProfileId,
      token: NodeToken.optional(),
    }),
    NodeTestResult,
    "admin",
  ),
} as const;

// ================================================================ Queries

export const QUERIES = {
  "system.status": def(z.object({ type: z.literal("system.status") }), SystemStatus, "read"),

  /** 还没配置过节点时 reviewerNode 为 null */
  "settings.get": def(
    z.object({ type: z.literal("settings.get") }),
    z.object({ reviewerNode: ReviewerNodeSettings.nullable() }),
    "admin",
  ),

  "projects.list": def(z.object({ type: z.literal("projects.list") }), z.array(Project), "read"),

  "messages.list": def(
    z.object({ type: z.literal("messages.list"), projectId: ProjectId }),
    z.array(Message),
    "read",
  ),

  "contributions.list": def(
    z.object({ type: z.literal("contributions.list"), projectId: ProjectId }),
    z.array(Contribution),
    "read",
  ),

  "snapshots.get": def(
    z.object({ type: z.literal("snapshots.get"), snapshotId: SnapshotId }),
    PromptSnapshot,
    "read",
  ),

  "approvals.list": def(
    z.object({
      type: z.literal("approvals.list"),
      projectId: ProjectId,
      /** 不传则返回全部 */
      pendingOnly: z.boolean().optional(),
    }),
    z.array(Approval),
    "read",
  ),

  "runs.list": def(
    z.object({
      type: z.literal("runs.list"),
      projectId: ProjectId,
      limit: z.number().int().min(1).max(200).optional(),
    }),
    z.array(Run),
    "read",
  ),

  "runs.get": def(z.object({ type: z.literal("runs.get"), runId: RunId }), Run, "read"),

  /** 回放某个 run 的事件；断线或重启后补齐 UI */
  "runs.events": def(
    z.object({
      type: z.literal("runs.events"),
      runId: RunId,
      afterSeq: z.number().int().min(-1).optional(),
    }),
    z.array(AgentEvent),
    "read",
  ),
} as const;

// ================================================================ Unions & helpers

type Registry = Record<string, { request: z.ZodTypeAny; response: z.ZodTypeAny; scope: ControlScope }>;
type Requests<R extends Registry> = { [K in keyof R]: R[K]["request"] }[keyof R];

const requestsOf = <R extends Registry>(r: R) =>
  Object.values(r).map((d) => d.request) as unknown as [Requests<R>, Requests<R>, ...Requests<R>[]];

export const ControlCommand = z.discriminatedUnion(
  "type",
  requestsOf(COMMANDS) as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]],
);
export const ControlQuery = z.discriminatedUnion(
  "type",
  requestsOf(QUERIES) as unknown as [z.ZodDiscriminatedUnionOption<"type">, ...z.ZodDiscriminatedUnionOption<"type">[]],
);

export type CommandType = keyof typeof COMMANDS;
export type QueryType = keyof typeof QUERIES;

export type CommandRequest<T extends CommandType = CommandType> = z.infer<(typeof COMMANDS)[T]["request"]>;
export type CommandResponse<T extends CommandType> = z.infer<(typeof COMMANDS)[T]["response"]>;
export type QueryRequest<T extends QueryType = QueryType> = z.infer<(typeof QUERIES)[T]["request"]>;
export type QueryResponse<T extends QueryType> = z.infer<(typeof QUERIES)[T]["response"]>;

export type ControlCommand = CommandRequest;
export type ControlQuery = QueryRequest;

// ================================================================ Results

export const ControlErrorCode = z.enum([
  "validation_failed", // 入参不符合 schema
  "forbidden",         // 客户端没有所需 scope
  "not_found",
  "invalid_state",     // 状态机不允许这个转换
  "stale_snapshot",    // expectedSnapshotHash 与当前 snapshot 不一致
  "already_decided",   // 审批或权限请求已经有结果
  "reviewer_not_configured",
  "internal",
]);
export type ControlErrorCode = z.infer<typeof ControlErrorCode>;

export const ControlError = z.object({
  ok: z.literal(false),
  error: ControlErrorCode,
  /** 给人看的说明。不包含密钥、不包含 prompt 原文 */
  message: z.string(),
});
export type ControlError = z.infer<typeof ControlError>;

export type ControlResult<T> = { ok: true; data: T } | ControlError;

export const controlResult = <T extends z.ZodTypeAny>(data: T) =>
  z.discriminatedUnion("ok", [z.object({ ok: z.literal(true), data }), ControlError]);

// ================================================================ Events（Orchestrator → 所有客户端）

export const ControlEvent = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.created"), message: Message }),
  z.object({ type: z.literal("approval.updated"), approval: Approval }),
  z.object({ type: z.literal("run.updated"), run: Run }),
  z.object({ type: z.literal("run.event"), event: AgentEvent }),
  z.object({ type: z.literal("permission.requested"), runId: RunId, request: PermissionRequest }),
]);
export type ControlEvent = z.infer<typeof ControlEvent>;
