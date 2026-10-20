import { ApprovalDecisionConflictError, ApprovalNotConsumableError, StaleSnapshotError } from "@room/db";
import { testReviewerNode } from "@room/remote-client";
import {
  APPROVAL_TRANSITIONS,
  COMMANDS,
  ControlCommand,
  ControlQuery,
  QUERIES,
  type AgentEvent,
  type CommandRequest,
  type ControlErrorCode,
  type ControlEvent,
  type ControlResult,
  type QueryRequest,
} from "@room/schemas";
import type { RunOrchestrator } from "./orchestrator";
import { Repository, RepositoryError } from "./repository";
import { SettingsError, type SettingsStore } from "./settings";

/**
 * IPC 分发（D-07）。
 *
 * 按契约的登记表校验入参和出参：校验失败返回 validation_failed，**不 throw**。
 * 只有三个频道（room:command / room:query / room:event），业务全走 control-api 的格式。
 */

export interface IpcDeps {
  readonly repo: Repository;
  readonly settings: SettingsStore;
  readonly orchestrator: RunOrchestrator;
  readonly appVersion: string;
  readonly recoveredRuns: number;
  readonly emit: (event: ControlEvent) => void;
}

/** 业务上可以直接映射到契约错误码的失败（不是 bug，也不是未预期异常）。 */
class ControlFailure extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = "ControlFailure";
    this.code = code;
  }
}

const errorResult = (error: ControlErrorCode, message: string): ControlResult<unknown> => ({
  ok: false,
  error,
  message,
});

function mapError(error: unknown): ControlResult<unknown> {
  if (error instanceof ControlFailure) {
    return errorResult(error.code, error.message);
  }
  if (error instanceof StaleSnapshotError) {
    return errorResult("stale_snapshot" as never, "这份 Prompt 已经变了，请重新预览再批准");
  }
  if (error instanceof ApprovalDecisionConflictError) {
    return errorResult("already_decided" as never, "这个审批已经被处理过");
  }
  if (error instanceof ApprovalNotConsumableError) {
    return errorResult(error.reason === "not_found" ? ("not_found" as never) : ("invalid_state" as never), error.message);
  }
  if (error instanceof RepositoryError) {
    const code = error.code === "invalid_selection" ? "validation_failed" : error.code;
    return errorResult(code as never, error.message);
  }
  if (error instanceof SettingsError) {
    return errorResult("internal" as never, error.message);
  }
  return errorResult("internal" as never, error instanceof Error ? error.message : String(error));
}

export function createDispatcher(deps: IpcDeps) {
  const { repo, settings, orchestrator } = deps;

  async function handleCommand(raw: unknown): Promise<ControlResult<unknown>> {
    const parsed = ControlCommand.safeParse(raw);
    if (!parsed.success) {
      return errorResult("validation_failed" as never, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const command = parsed.data as CommandRequest;

    try {
      const data = await runCommand(command);
      const responseSchema = COMMANDS[command.type as keyof typeof COMMANDS].response;
      const checked = responseSchema.safeParse(data);
      if (!checked.success) {
        return errorResult("internal" as never, "response does not match contract: " + checked.error.issues[0]?.message);
      }
      return { ok: true, data: checked.data };
    } catch (error) {
      return mapError(error);
    }
  }

  async function runCommand(command: CommandRequest): Promise<unknown> {
    switch (command.type) {
      case "project.create":
        return repo.createProject(command.name);

      case "source.add": {
        const message = await repo.addSource(command.projectId, command.sourceAgent, command.content);
        deps.emit({ type: "message.created", message });
        return message;
      }

      case "contribution.create":
        return repo.createContribution({
          projectId: command.projectId,
          sourceMessageId: command.sourceMessageId,
          contributionType: command.contributionType,
          title: command.title,
          selection: command.selection,
        });

      case "snapshot.create": {
        const node = settings.get();
        const result = await repo.createSnapshot({
          projectId: command.projectId,
          contributionIds: [...command.contributionIds],
          taskInstruction: command.taskInstruction,
          reviewerAgent: node?.profileId ?? "unconfigured",
        });
        deps.emit({ type: "approval.updated", approval: result.approval });
        return result;
      }

      case "approval.approve": {
        const node = settings.get();
        const token = settings.getToken();
        if (node === null || token === null) {
          throw new ControlFailure("reviewer_not_configured", "请先在设置里配置 Reviewer 节点和 Token");
        }
        // 批准的是一个具体 Prompt，Reviewer 变了就不能沿用这次批准
        const pending = repo.getApproval(command.approvalId);
        const snapshotForRun = repo.getSnapshot(pending.snapshotId);
        if (snapshotForRun.reviewerAgent !== node.profileId) {
          throw new ControlFailure(
            "invalid_state",
            "Reviewer 设置已变，请重新生成 Prompt",
          );
        }

        const approved = await repo.approve({
          approvalId: command.approvalId,
          expectedSnapshotHash: command.expectedSnapshotHash,
          // Run 的 adapterId 用 snapshot 里记录的那个，不跟着当前设置走
          adapterId: snapshotForRun.reviewerAgent,
        });
        deps.emit({ type: "approval.updated", approval: approved.approval });
        deps.emit({ type: "run.updated", run: approved.run });

        const snapshot = repo.getSnapshot(approved.run.snapshotId);
        const runRow = {
          id: approved.run.id,
          project_id: approved.run.projectId,
          approval_id: approved.run.approvalId,
          snapshot_id: approved.run.snapshotId,
          adapter_id: approved.run.adapterId,
          state: approved.run.state,
          substate: null,
          failure_reason: null,
          created_at: approved.run.createdAt,
          started_at: null,
          finished_at: null,
        };
        // 立刻返回，执行在后台进行；兜底必须有人接住，否则会变成 main 的 unhandled rejection
        void orchestrator
          .start(runRow, {
            snapshotId: snapshot.id,
            content: snapshot.content,
            contentHash: snapshot.contentHash,
            reviewerAgent: snapshot.reviewerAgent,
          })
          .catch((error: unknown) => {
            // 只记消息，不记 payload / token
            console.error("[orchestrator] run failed:", error instanceof Error ? error.message : String(error));
          });
        return approved;
      }

      case "approval.reject": {
        const approval = await repo.reject(command.approvalId, command.reason);
        deps.emit({ type: "approval.updated", approval });
        return approval;
      }

      case "run.cancel": {
        orchestrator.cancel(command.runId);
        return repo.getRun(command.runId);
      }

      case "permission.decide":
        // Phase 0 的 Reviewer 走节点，不产生权限请求
        return {};

      case "settings.updateReviewerNode":
        return settings.updateReviewerNode({
          baseUrl: command.baseUrl,
          profileId: command.profileId,
          token: command.token,
        });

      case "settings.testReviewerNode": {
        // 只有地址没变时才复用已保存的 token：否则用户把地址改成别的机器，
        // 一按「测试连接」就把 token 明文发过去了。
        const saved = settings.get();
        const sameTarget = saved !== null && saved.baseUrl === command.baseUrl;
        const token = command.token ?? (sameTarget ? settings.getToken() : null);
        if (token === null) {
          return {
            reachable: false,
            error: "no_token",
            message: sameTarget ? "还没有配置 Token" : "地址变了，请重新输入 Token",
          };
        }
        return testReviewerNode({ baseUrl: command.baseUrl, token, profileId: command.profileId });
      }
    }
  }

  async function handleQuery(raw: unknown): Promise<ControlResult<unknown>> {
    const parsed = ControlQuery.safeParse(raw);
    if (!parsed.success) {
      return errorResult("validation_failed" as never, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const query = parsed.data as QueryRequest;

    try {
      const data = runQuery(query);
      const responseSchema = QUERIES[query.type as keyof typeof QUERIES].response;
      const checked = responseSchema.safeParse(data);
      if (!checked.success) {
        return errorResult("internal" as never, "response does not match contract: " + checked.error.issues[0]?.message);
      }
      return { ok: true, data: checked.data };
    } catch (error) {
      return mapError(error);
    }
  }

  function runQuery(query: QueryRequest): unknown {
    switch (query.type) {
      case "system.status": {
        const node = settings.get();
        return {
          appVersion: deps.appVersion,
          reviewerConfigured: node?.tokenConfigured ?? false,
          reviewerAgent: node?.profileId ?? "unconfigured",
          recoveredRuns: deps.recoveredRuns,
        };
      }

      case "settings.get":
        return { reviewerNode: settings.get() };

      case "projects.list":
        return repo.listProjects();

      case "messages.list":
        return repo.listMessages(query.projectId);

      case "contributions.list":
        return repo.listContributions(query.projectId);

      case "snapshots.get":
        return repo.getSnapshot(query.snapshotId);

      case "approvals.list":
        return repo.listApprovals(query.projectId, query.pendingOnly === true);

      case "runs.list":
        return repo.listRuns(query.projectId, query.limit ?? 20);

      case "runs.get":
        return repo.getRun(query.runId);

      case "runs.events": {
        const rows = repo.listEvents(query.runId, query.afterSeq ?? -1);
        // eventId / runId 必须用数据库里的值：payload 里存的是 adapter 自己编的 eventId，
        // 与直播推送用的 stored.eventId 不同，重放时同一个事件会出现两个 id。
        return rows.map((row) => ({
          ...(row.payload as object),
          type: row.type,
          eventId: row.eventId,
          runId: query.runId,
          seq: row.seq,
          ts: row.ts,
        })) as AgentEvent[];
      }
    }
  }

  return { handleCommand, handleQuery };
}

export { APPROVAL_TRANSITIONS };
