import {
  assembleDiscussionBatch,
  assembleSummaryPrompt,
  createNonce,
  type DiscussionHistoryRound,
} from "@room/core";
import {
  approveBatch,
  BatchApproveError,
  createRoundDraft,
  createSummaryDraft,
  newRoundId,
  RoundDraftError,
  type SqliteDatabase,
  type WriteQueue,
} from "@room/db";
import { testReviewerNode } from "@room/remote-client";
import type {
  AgentProfile,
  ApprovalBatch,
  CommandRequest,
  ControlErrorCode,
  ControlEvent,
  PlanVersion,
  Round,
  Turn,
} from "@room/schemas";
import type { DiscussionSettlement, RunOrchestrator } from "./orchestrator";
import type { Repository } from "./repository";
import type { SettingsStore } from "./settings";

/**
 * 讨论室的命令实现（D-22 / PR B）：round.draft、batch.approve、round.summarize。
 *
 * 分工：
 * - Prompt 拼装交给 @room/core（assembleDiscussionBatch / assembleSummaryPrompt）
 * - 落库交给 @room/db（一个事务里建出轮 / 批次 / 快照 / 批准 / Turn）
 * - 这里只做「读现状 → 拼 Prompt → 调 db → 推事件 → 起 Run」
 *
 * 事件顺序照 mock（C-21）：先消息、再 Turn、再方案 / 汇总，最后轮；run.updated 由 Orchestrator 发。
 */

export class DiscussionError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = "DiscussionError";
    this.code = code;
  }
}

export interface NodeProbeResult {
  reachable: boolean;
  /** 节点上可用的 profile 列表（/v1/health 的 profiles） */
  profiles: string[];
  message?: string;
}

export interface DiscussionDeps {
  readonly db: SqliteDatabase;
  readonly queue: WriteQueue;
  readonly repo: Repository;
  readonly settings: SettingsStore;
  readonly orchestrator: RunOrchestrator;
  readonly emit: (event: ControlEvent) => void;
  /** 测试注入；默认打节点的 /v1/health */
  readonly probeNode?: (params: { baseUrl: string; token: string; profileId: string }) => Promise<NodeProbeResult>;
}

type AvailabilityNeed = "discuss" | "summarize";

/**
 * 额度缺席只在 5 小时内算数：过了这段时间可能是额度重置了，不能一直挡着。
 * 1A 还没有真正的额度接口，这是按「上一次发言的结局」做的近似。
 */
const QUOTA_ABSENT_WINDOW_MS = 5 * 60 * 60 * 1000;

interface PendingRecipient {
  agentId: string;
  displayName: string;
  nodeId: string;
  baseUrl: string;
  profileId: string;
}

/** 和 ux_round_active 一致：这些状态的轮没结束，不能再起草新的一轮 */
const ACTIVE_ROUND_STATES: ReadonlySet<Round["state"]> = new Set<Round["state"]>([
  "DRAFT",
  "RUNNING",
  "PAUSED",
  "AWAITING_SUMMARY",
  "SUMMARIZING",
]);

export class DiscussionService {
  readonly #deps: DiscussionDeps;

  constructor(deps: DiscussionDeps) {
    this.#deps = deps;
  }

  /**
   * 起草新的一轮（round.draft）。
   *
   * 收件人在拼 Prompt 之前先过一遍可用性：没配置 / 被暂停 / 额度缺席 / 节点离线都返回
   * agent_unavailable，并写明是谁——确认页还没出现就失败，比发出去一半再失败好。
   */
  async draft(command: CommandRequest<"round.draft">): Promise<{ round: Round; batch: ApprovalBatch }> {
    const { repo, db, queue, emit } = this.#deps;
    const project = repo.getProject(command.projectId);

    // 先看轮再看人：有一轮没结束时，报「还没结束」比报某个 Agent 不可用更贴近用户看到的东西
    const active = repo.listRounds(project.id).find((round) => ACTIVE_ROUND_STATES.has(round.state));
    if (active !== undefined) {
      throw new DiscussionError("invalid_state", "这个议题的第 " + active.index + " 轮还没结束");
    }

    await this.#checkRecipients(command.recipients, project.id, "discuss");
    const agents: AgentProfile[] = command.recipients.map((agentId) => repo.getAgent(agentId));

    const plan = command.planVersionId === null ? null : this.#loadPlan(project.id, command.planVersionId);
    const roundId = newRoundId();
    const roundIndex = repo.nextRoundIndex(project.id);
    const roundForPrompt: Round = {
      id: roundId,
      projectId: project.id,
      index: roundIndex,
      state: "DRAFT",
      task: command.task,
      taskSource: command.taskSource,
      recipients: [...command.recipients],
      planVersionId: command.planVersionId,
      historyMode: command.historyMode,
      voidReason: null,
      activeMs: 0,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    };

    const prompts = assembleDiscussionBatch(
      {
        round: roundForPrompt,
        history: repo.discussionHistory(project.id, roundIndex),
        materials: [],
        plan,
        nonce: createNonce(),
      },
      agents.map((profile) => ({ profile, onBehalfOf: null, extraMaterials: [] })),
    );

    let created: Awaited<ReturnType<typeof createRoundDraft>>;
    try {
      created = await createRoundDraft(db, queue, {
        projectId: project.id,
        roundId,
        recipients: agents.map((profile, index) => ({
          agent: profile.id,
          prompt: prompts[index]!,
        })),
        task: command.task,
        taskSource: command.taskSource,
        planVersionId: command.planVersionId,
        historyMode: command.historyMode,
        compressedRounds: prompts[0]?.compressedRounds ?? [],
      });
    } catch (error) {
      throw mapDraftError(error);
    }

    const round = repo.getRound(created.round.id);
    const batch = repo.getBatch(created.batch.id);
    emit({ type: "round.updated", round });
    emit({ type: "batch.updated", batch });
    for (const turn of repo.listTurnsByBatch(batch.id)) emit({ type: "turn.updated", turn });
    for (const item of batch.items) emit({ type: "approval.updated", approval: repo.getApproval(item.approvalId) });
    return { round, batch };
  }

  /**
   * 一次盖章（batch.approve）：批准 + 建 Run 在 db 的一个事务里完成，
   * 这里只负责把 Run 交给 Orchestrator，并按「先落库、后起跑」的顺序推事件。
   */
  async approve(command: CommandRequest<"batch.approve">): Promise<{ batch: ApprovalBatch; turns: Turn[] }> {
    const { repo, db, queue, emit, orchestrator } = this.#deps;

    let result: Awaited<ReturnType<typeof approveBatch>>;
    try {
      result = await approveBatch(db, queue, {
        batchId: command.batchId,
        items: command.expected.map((item) => ({ approvalId: item.approvalId, expectedContentHash: item.contentHash })),
        via: "desktop",
      });
    } catch (error) {
      throw mapApproveError(error);
    }

    const batch = repo.getBatch(result.batchId);
    const turns = result.turnIds.map((turnId) => repo.getTurn(turnId));
    const round = repo.getRound(result.roundId);

    for (const item of batch.items) emit({ type: "approval.updated", approval: repo.getApproval(item.approvalId) });
    emit({ type: "batch.updated", batch });
    for (const turn of turns) emit({ type: "turn.updated", turn });
    emit({ type: "round.updated", round });

    // 先把每个 Run 和它的 Turn / Snapshot 全部配好对，再统一 start：
    // 配对时抛错的话一个 Run 都还没起跑，不会出现「一半已经发出去」。
    const launches = result.runIds.map((runId) => {
      const run = repo.getRunRow(runId);
      const turn = turns.find((candidate) => candidate.runId === runId);
      if (turn === undefined) {
        throw new DiscussionError("internal", "run " + runId + " has no turn");
      }
      return { run, turn, snapshot: repo.getSnapshot(run.snapshot_id) };
    });

    for (const { run, turn, snapshot } of launches) {
      // 立刻返回，执行在后台进行；兜底必须有人接住，否则会变成 main 的 unhandled rejection
      void orchestrator
        .start(run, {
          snapshotId: snapshot.id,
          content: snapshot.content,
          contentHash: snapshot.contentHash,
          reviewerAgent: snapshot.reviewerAgent,
          discussion: { turnId: turn.id, isSummary: turn.isSummary },
        })
        .catch((error: unknown) => {
          console.error("[orchestrator] discussion run failed:", error instanceof Error ? error.message : String(error));
        });
    }

    return { batch, turns };
  }

  /**
   * 请汇总者汇总这一轮（round.summarize）。汇总同样要盖章，所以这里只建批次，不发。
   *
   * 0-B 的两条约束在这里先挡一次（db 只挡轮的状态）：
   * - 这一轮没有任何正式回答 → invalid_state（界面建议改为作废）
   * - 汇总者当过本轮的替补 → invalid_state（替补不能是汇总者）
   */
  async summarize(command: CommandRequest<"round.summarize">): Promise<ApprovalBatch> {
    const { repo, db, queue, emit } = this.#deps;
    const round = repo.getRound(command.roundId);
    if (round.state !== "AWAITING_SUMMARY") {
      throw new DiscussionError("invalid_state", "这一轮还不能汇总（要先等所有人都结束，或点「结束本轮」）");
    }
    if (repo.countAnsweredTurns(round.id) === 0) {
      throw new DiscussionError("invalid_state", "这一轮没有任何回答，没什么可汇总的；可以改方向（作废这一轮）");
    }

    await this.#checkRecipients([command.summarizer], round.projectId, "summarize");
    const summarizer = repo.getAgent(command.summarizer);
    if (repo.hasTurnAsSubstitute(round.id, summarizer.id)) {
      throw new DiscussionError("invalid_state", summarizer.displayName + " 在这一轮当过替补，不能再做汇总");
    }

    const plan = round.planVersionId === null ? null : this.#loadPlan(round.projectId, round.planVersionId);
    const history: DiscussionHistoryRound[] = repo.discussionHistory(round.projectId, round.index + 1);
    // 汇总者要看到本轮的发言：把当前轮也放进历史（core 允许 index <= 当前轮）
    history.push({
      round,
      messages: repo.listMessagesByRound(round.id),
      turns: repo.listTurns(round.id),
      summary: null,
    });

    const prompt = assembleSummaryPrompt(
      { round, history, materials: [], plan, nonce: createNonce() },
      { profile: summarizer, onBehalfOf: null, extraMaterials: [] },
    );

    let created: Awaited<ReturnType<typeof createSummaryDraft>>;
    try {
      created = await createSummaryDraft(db, queue, {
        roundId: round.id,
        recipients: [{ agent: summarizer.id, prompt }],
        compressedRounds: prompt.compressedRounds,
      });
    } catch (error) {
      throw mapDraftError(error);
    }

    const batch = repo.getBatch(created.batch.id);
    emit({ type: "batch.updated", batch });
    for (const turn of repo.listTurnsByBatch(batch.id)) emit({ type: "turn.updated", turn });
    for (const item of batch.items) emit({ type: "approval.updated", approval: repo.getApproval(item.approvalId) });
    return batch;
  }

  /**
   * Orchestrator 收尾之后，把讨论室的变化推给界面：
   * 消息 → Turn → 方案 → 汇总 → 轮（run.updated / run.event 由 Orchestrator 自己发）。
   */
  settled(settlement: DiscussionSettlement): void {
    const { repo, emit } = this.#deps;
    if (settlement.messageId !== null) {
      emit({ type: "message.created", message: repo.getMessage(settlement.messageId) });
    }
    emit({ type: "turn.updated", turn: repo.getTurn(settlement.turnId) });

    if (settlement.planVersionId !== null) {
      const plan = repo.getPlan(settlement.planVersionId);
      emit({ type: "plan.updated", plan });
    }
    if (settlement.roundSummaryId !== null) {
      const summary = repo.getRoundSummary(settlement.roundId);
      if (summary !== null) emit({ type: "summary.created", summary });
    }
    emit({ type: "round.updated", round: repo.getRound(settlement.roundId) });
  }

  #loadPlan(projectId: string, planVersionId: string): PlanVersion {
    const plan = this.#deps.repo.getPlan(planVersionId);
    if (plan.projectId !== projectId) {
      throw new DiscussionError("invalid_state", "这个方案不属于当前议题");
    }
    return plan;
  }

  /**
   * 一批收件人现在能不能发。
   *
   * 先做本地判断（配置 / 暂停 / 额度 / 节点地址），再把要探的节点**按节点去重、并发**探一次：
   * 三个人在同一个节点上只打一次 /v1/health，而不是每人一次。
   *
   * - 额度缺席：本议题里这个人最新一次发言是 absent_quota，且结束时间在 5 小时内
   *   （更早的可能是额度重置了，放行；1A 还没有真正的额度接口）
   * - 节点离线 / 没有这个 profile：不发
   *
   * 多节点各自的 Token 还没有地方存，所以非「已配置节点」上的 Agent 会被判成不可用——
   * 那是 D-22c 的事。
   */
  async #checkRecipients(agentIds: readonly string[], projectId: string, need: AvailabilityNeed): Promise<void> {
    const { repo, settings } = this.#deps;
    const configured = settings.get();
    const token = settings.getToken();
    const pending: PendingRecipient[] = [];

    for (const agentId of agentIds) {
      const row = repo.getAgentRow(agentId);
      if (row === undefined) {
        throw new DiscussionError("agent_unavailable", "参与者 " + agentId + " 还没有配置");
      }
      const displayName = row["display_name"] as string;
      if (row["paused_by_user"] === 1) {
        throw new DiscussionError("agent_unavailable", displayName + " 被手动暂停了");
      }
      if (need === "discuss" && row["can_discuss"] !== 1) {
        throw new DiscussionError("agent_unavailable", displayName + " 没有开启「参与讨论」");
      }
      if (need === "summarize" && row["can_summarize"] !== 1) {
        throw new DiscussionError("agent_unavailable", displayName + " 没有开启「可以做汇总」");
      }

      const latest = repo.latestTurnOutcome(projectId, agentId);
      if (latest !== null && latest.outcome === "absent_quota" && this.#isRecentQuotaAbsence(latest.finishedAt)) {
        throw new DiscussionError("agent_unavailable", displayName + " 额度用尽（缺席）");
      }

      const nodeId = row["node_id"] as string | null;
      const profileId = row["profile_id"] as string | null;
      if (nodeId === null || profileId === null) {
        throw new DiscussionError("agent_unavailable", displayName + " 还没有配置节点或 profile");
      }
      const node = repo.getNodeRow(nodeId);
      if (node === undefined || node.base_url === null) {
        throw new DiscussionError("agent_unavailable", displayName + " 所在的节点 " + nodeId + " 还没有配置地址");
      }
      if (configured === null || token === null || configured.baseUrl !== node.base_url) {
        throw new DiscussionError(
          "agent_unavailable",
          displayName + " 所在的节点还没有接通（目前只保存了一个节点的 Token）",
        );
      }

      pending.push({ agentId, displayName, nodeId, baseUrl: node.base_url, profileId });
    }

    if (pending.length === 0) return;

    // 同一个节点只探一次；不同节点之间并发
    const byNode = new Map<string, PendingRecipient[]>();
    for (const item of pending) byNode.set(item.nodeId, [...(byNode.get(item.nodeId) ?? []), item]);

    const probes = new Map<string, NodeProbeResult>();
    await Promise.all(
      [...byNode.values()].map(async (items) => {
        const first = items[0]!;
        probes.set(first.nodeId, await this.#probe({ baseUrl: first.baseUrl, token: token as string, profileId: first.profileId }));
      }),
    );

    for (const item of pending) {
      const probe = probes.get(item.nodeId)!;
      if (!probe.reachable) {
        throw new DiscussionError(
          "agent_unavailable",
          item.displayName + " 所在的节点离线" + (probe.message === undefined ? "" : "：" + probe.message),
        );
      }
      if (!probe.profiles.includes(item.profileId)) {
        throw new DiscussionError("agent_unavailable", item.displayName + " 的 profile " + item.profileId + " 不在节点上");
      }
    }
  }

  /** 5 小时内算「还缺席」；时间戳缺失或解析不了就当过期（放行） */
  #isRecentQuotaAbsence(finishedAt: string | null): boolean {
    if (finishedAt === null) return false;
    const at = Date.parse(finishedAt);
    return Number.isFinite(at) && Date.now() - at <= QUOTA_ABSENT_WINDOW_MS;
  }

  async #probe(params: { baseUrl: string; token: string; profileId: string }): Promise<NodeProbeResult> {
    if (this.#deps.probeNode !== undefined) return this.#deps.probeNode(params);
    const result = await testReviewerNode({ ...params, timeoutMs: 3_000 });
    return result.reachable
      ? { reachable: true, profiles: result.health.profiles }
      : { reachable: false, profiles: [], message: result.message };
  }
}

function mapApproveError(error: unknown): unknown {
  if (!(error instanceof BatchApproveError)) return error;
  switch (error.code) {
    case "batch_not_found":
      return new DiscussionError("not_found", error.message);
    case "batch_not_ready":
      return new DiscussionError("already_decided", "这一批已经处理过了");
    case "hash_mismatch":
      return new DiscussionError("stale_snapshot", "要发送的内容和你看到的不一致，请重新打开确认页");
    default:
      return new DiscussionError("invalid_state", error.message);
  }
}

function mapDraftError(error: unknown): unknown {
  if (!(error instanceof RoundDraftError)) return error;
  switch (error.code) {
    case "round_active":
      return new DiscussionError("invalid_state", "这个议题还有一轮没有结束");
    case "round_not_found":
      return new DiscussionError("not_found", error.message);
    case "round_not_awaiting_summary":
      return new DiscussionError("invalid_state", "这一轮不在待汇总状态");
    case "invalid_input":
      return new DiscussionError("validation_failed", error.message);
    default:
      return new DiscussionError("internal", error.message);
  }
}
