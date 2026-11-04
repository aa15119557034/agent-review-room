import { WorkspaceError } from "@room/db";
import type { WorkspaceService } from "./workspace";
import { ApprovalDecisionConflictError, ApprovalNotConsumableError, StaleSnapshotError } from "@room/db";
import { testReviewerNode } from "@room/remote-client";
import {
  APPROVAL_TRANSITIONS,
  COMMANDS,
  DEFAULT_APPEARANCE,
  DEFAULT_IMMERSIVE_SETTINGS,
  ControlCommand,
  ControlQuery,
  QUERIES,
  type AgentEvent,
  type CommandRequest,
  type ControlErrorCode,
  type ControlEvent,
  type ControlResult,
  type QueryRequest,
  type VoiceOption,
} from "@room/schemas";
import { ChatError, type ChatService } from "./chat";
import { GithubError, type GithubSyncService } from "./github";
import { NoteError, type NotesService } from "./notes";
import { DiscussionError, type DiscussionService } from "./discussion";
import type { MediaJobsService } from "./media-jobs";
import type { MediaService } from "./media";
import { NodeServiceError, type NodeService } from "./nodes";
import type { VoiceService } from "./voice";
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
  readonly workspace?: WorkspaceService;
  readonly repo: Repository;
  readonly settings: SettingsStore;
  readonly orchestrator: RunOrchestrator;
  readonly discussion: DiscussionService;
  /** D-31b：聊天服务；测试里可以不传（那时 chat.* 返回 internal） */
  readonly chat?: ChatService;
  /** C-46：项目笔记（改 / 回退 / 列表 / 历史） */
  readonly notes?: NotesService;
  /** D-46c：项目笔记同步到 GitHub */
  readonly github?: GithubSyncService;
  /** D-34a：聊天文件和表情库（选文件对话框、按内容去重） */
  readonly media?: MediaService;
  /** D-38a：画图任务（本机 ComfyUI + 全局队列） */
  readonly jobs?: MediaJobsService;
  /** D-37b：可选的声音（userData/tts.json）；没配置 = 空列表 */
  readonly voices?: () => VoiceOption[];
  /** D-34b：录音导入与本地转写 */
  readonly voice?: VoiceService;
  readonly nodes: NodeService;
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
  if (error instanceof WorkspaceError) return errorResult(error.code, error.message);
  if (error instanceof ControlFailure) {
    return errorResult(error.code, error.message);
  }
  if (error instanceof DiscussionError) {
    return errorResult(error.code, error.message);
  }
  if (error instanceof ChatError) {
    return errorResult(error.code, error.message);
  }
  if (error instanceof NoteError) {
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
  if (error instanceof NodeServiceError) {
    return errorResult(error.code as never, error.message);
  }
  return errorResult("internal" as never, error instanceof Error ? error.message : String(error));
}

export function createDispatcher(deps: IpcDeps) {
  const { repo, settings, orchestrator } = deps;
  const workspace = () => { if (!deps.workspace) throw new ControlFailure("internal", "资料与维护服务没有启动"); return deps.workspace; };

  const chatService = (): ChatService => {
    if (deps.chat === undefined) throw new ControlFailure("internal", "聊天服务没有启动");
    return deps.chat;
  };

  const jobsService = (): MediaJobsService => {
    if (deps.jobs === undefined) throw new ControlFailure("internal", "画图服务没有启动");
    return deps.jobs;
  };

  const mediaService = (): MediaService => {
    if (deps.media === undefined) throw new ControlFailure("internal", "媒体服务没有启动");
    return deps.media;
  };

  const githubService = (): GithubSyncService => {
    if (deps.github === undefined) throw new ControlFailure("internal", "GitHub 同步没有启动");
    return deps.github;
  };

  const notesService = (): NotesService => {
    if (deps.notes === undefined) throw new ControlFailure("internal", "笔记服务没有启动");
    return deps.notes;
  };

  const voiceService = (): VoiceService => {
    if (deps.voice === undefined) throw new ControlFailure("internal", "语音服务没有启动");
    return deps.voice;
  };

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
      case "workspace.openRestored": return workspace().openRestored();
      case "workspace.useDefaultData": return workspace().openRestored(true);
      case "workspace.backup": return workspace().backup();
      case "workspace.restore": return workspace().restore();
      case "workspace.diagnostics.export": return workspace().exportDiagnostics();
      case "workspace.export": return workspace().exportScope(command);
      case "workspace.decision.save": return workspace().saveDecision(command);
      case "projectNote.edit":
        return notesService().edit({
          scope: command.scope,
          agent: command.agent,
          content: command.content,
          expectedParentId: command.expectedParentId,
        });

      case "projectNote.revert":
        return notesService().revert(command.noteId);

      case "chat.window.prepare":
        return chatService().prepareWindow(command);

      case "chat.window.editDraft":
        return chatService().editWindowDraft(command);

      case "chat.window.redo":
        return chatService().redoWindowDraft(command);

      case "chat.window.confirm":
        return chatService().confirmWindow(command);

      case "chat.window.cancel":
        return chatService().cancelWindow(command);

      case "github.update":
        return githubService().update(command);

      case "github.pushNow":
        return githubService().pushNow();

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

      // ---------------------------------------------------------------- 讨论室（D-22 / PR B）
      case "round.draft":
        return deps.discussion.draft(command);

      case "batch.approve":
        return deps.discussion.approve(command);

      case "round.summarize":
        return deps.discussion.summarize(command);

      case "agent.update":
        return deps.discussion.updateAgent(command);

      case "batch.reject":
        return deps.discussion.reject(command);

      case "plan.confirm":
        return deps.discussion.confirmPlan(command);

      case "plan.finalize":
        return deps.discussion.finalizePlan(command);

      case "round.pause":
        return deps.discussion.pause(command);

      case "round.end":
        return deps.discussion.end(command);

      case "round.resume":
        return deps.discussion.resume(command);

      case "round.supplement":
        return deps.discussion.supplement(command);

      case "round.retry":
        return deps.discussion.retry(command);

      case "round.void":
        return deps.discussion.voidRound(command);

      case "round.redraft":
        return deps.discussion.redraft(command);

      case "note.add":
        return deps.discussion.addNote(command);

      case "plan.create":
        return deps.discussion.createPlan(command);

      case "plan.edit":
        return deps.discussion.editPlan(command);

      case "plan.derive":
        return deps.discussion.derivePlan(command);

      case "node.upsert":
        return deps.nodes.upsert(command);

      case "node.test":
        return deps.nodes.test(command);

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

      // ---------------------------------------------------------------- 聊天（D-31b）
      case "chat.conversation.create":
        return chatService().createConversation(command);
      case "chat.conversation.update":
        return chatService().updateConversation(command);
      case "chat.conversation.markRead":
        return chatService().markRead(command);
      case "chat.send":
        return chatService().send(command);
      case "chat.retract":
        return chatService().retract(command);
      case "chat.retry":
        return chatService().retry(command);
      case "chat.cancelReply":
        return chatService().cancelReply(command);
      case "chat.toTopic":
        return chatService().toTopic(command);

      // D-34a：文件和表情库
      case "chat.attachment.pick":
        return mediaService().pickAttachment(command.kind);
      case "chat.sticker.add":
        return mediaService().addSticker(command.label);
      case "chat.sticker.update":
        return mediaService().updateSticker(command.stickerId, command.label);
      case "chat.sticker.remove":
        return mediaService().removeSticker(command.stickerId);

      // D-38a：画图任务
      case "draw.start":
        return jobsService().start(command.request, command.source, command.confirmOverThreshold === true);
      case "media.cancel":
        return jobsService().cancel(command.jobId);
      case "media.stop":
        return jobsService().stop(command.scope);

      // 还没上线：明确拒绝，不要返回 undefined 让出参校验兜成 internal
      case "speech.play":
        return jobsService().play(command.source);
      case "immersive.update":
        return chatService().updateImmersive(command.conversationId, command.settings);
      case "image.pick":
        throw new ChatError("validation_failed", "头像 / 背景选图还没上线（D-39）");
      case "appearance.update":
        throw new ChatError("validation_failed", "外观设置还没上线（D-39）");
      case "node.importLocalToken":
        return deps.nodes.importLocalToken(command);
      case "chat.voice.import":
        return voiceService().import(command);
    }
  }

  async function handleQuery(raw: unknown): Promise<ControlResult<unknown>> {
    const parsed = ControlQuery.safeParse(raw);
    if (!parsed.success) {
      return errorResult("validation_failed" as never, parsed.error.issues.map((i) => i.message).join("; "));
    }
    const query = parsed.data as QueryRequest;

    try {
      const data = await runQuery(query);
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

  async function runQuery(query: QueryRequest): Promise<unknown> {
    switch (query.type) {
      case "workspace.sources": return workspace().sources(query.projectId);
      case "workspace.search": return workspace().search(query);
      case "workspace.item": return workspace().item(query);
      case "workspace.health": return workspace().health();
      case "workspace.diagnostics": return workspace().diagnostics();
      case "workspace.tasks": return workspace().tasks(query);
      case "workspace.decisions": return workspace().decisions(query);
      case "workspace.export.preview": return workspace().preview(query.scope);
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

      case "agents.list":
        return repo.listAgents();

      case "nodes.list":
        return deps.nodes.list();

      case "runs.get":
        return repo.getRun(query.runId);

      // ---------------------------------------------------------------- 讨论室（D-22d 读取）
      case "rounds.list":
        return repo.listRounds(query.projectId);

      case "rounds.get":
        return {
          round: repo.getRound(query.roundId),
          batches: repo.listBatches(query.roundId),
          turns: repo.listTurns(query.roundId),
          summary: repo.getRoundSummary(query.roundId),
        };

      case "batches.get": {
        const batch = repo.getBatch(query.batchId);
        return { batch, snapshots: repo.listSnapshotsForBatch(batch.id) };
      }

      case "plans.list":
        return repo.listPlans(query.projectId);

      case "agents.status":
        return deps.discussion.agentStatuses();

      case "agents.activity":
        return deps.discussion.activity(query);

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

      // ---------------------------------------------------------------- 聊天（D-31b）
      case "chat.conversations.list":
        return chatService().listConversations();
      case "chat.conversations.get":
        return chatService().getConversation(query.conversationId);
      case "chat.messages.list":
        return chatService().listMessages(query);
      case "chat.slots.runs":
        return chatService().listSlotRuns(query.slotId);
      case "github.get":
        return githubService().status();
      case "chat.windows.get":
        return chatService().windowStatuses(query.conversationId);
      case "chat.windows.list":
        return chatService().windowList(query.conversationId);
      case "chat.runs.get":
        return chatService().getRun(query.runId);
      case "chat.snapshots.get":
        return chatService().getSnapshot(query.snapshotId);
      case "projectNotes.list":

        return notesService().list(query.scope);

      case "projectNotes.history":

        return notesService().history(query.scope, query.agent);

      case "chat.summaries.list":
        return chatService().listSummaries(query.conversationId);
      case "chat.stickers.list":
        return mediaService().listStickers();
      case "chat.voice.get":
        return voiceService().get(query);

      // 还没接但界面会查：返回契约里的默认值，别让界面看到英文的 internal 错误
      case "appearance.get":
        return DEFAULT_APPEARANCE;
      case "voices.list":
        return deps.voices?.() ?? [];
      case "immersive.get":
        return chatService().immersive(query.conversationId);

      // D-38a：画图任务
      case "draw.preview":
        return jobsService().preview(query.request);
      case "media.get":
        return jobsService().get(query.jobId);
      case "media.list":
        return jobsService().list(query.scope, query.messageIds);
    }
  }

  return { handleCommand, handleQuery };
}

export { APPROVAL_TRANSITIONS };


