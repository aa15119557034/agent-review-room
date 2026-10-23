import {
  assembleDiscussionBatch,
  assembleSummaryPrompt,
  createNonce,
  type DiscussionHistoryRound,
} from "@room/core";
import {
  approveBatch,
  BatchApproveError,
  confirmPlan as confirmPlanTx,
  createBatchDraft,
  createPlan as createPlanTx,
  createResumeBatch,
  createRoundDraft,
  createSummaryDraft,
  derivePlan as derivePlanTx,
  editPlan as editPlanTx,
  endRound,
  finalizePlan as finalizePlanTx,
  interruptTurns,
  newRoundId,
  pauseRound,
  PlanError,
  redraftRound,
  rejectBatch,
  RoundDraftError,
  TurnError,
  voidRound as voidRoundTx,
  type SqliteDatabase,
  type WriteQueue,
} from "@room/db";
import { testReviewerNode } from "@room/remote-client";
import type {
  AgentProfile,
  AgentStatus,
  ApprovalBatch,
  BatchModel,
  CommandRequest,
  ControlErrorCode,
  ControlEvent,
  Message,
  PlanVersion,
  Round,
  RunOccasion,
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
  /** C-40：节点按 profile 上报的模型和强度；老节点没有这个字段 */
  profileModels?: import("@room/schemas").ProfileModels[];
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

    const probes = await this.#checkRecipients(command.recipients, "discuss");
    const agents: AgentProfile[] = command.recipients.map((agentId) => repo.getAgent(agentId));
    const models = this.#selectModels(agents, "discussion", probes);

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
          model: models.get(profile.id) ?? null,
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
        items: command.expected.map((item) => ({
          approvalId: item.approvalId,
          expectedContentHash: item.contentHash,
          model: item.model,
        })),
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

    const probes = await this.#checkRecipients([command.summarizer], "summarize");
    const summarizer = repo.getAgent(command.summarizer);
    const summarizerModel = this.#selectModels([summarizer], "summary", probes).get(summarizer.id) ?? null;
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
        recipients: [{ agent: summarizer.id, prompt, model: summarizerModel }],
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

  // ---------------------------------------------------------------- 一轮的控制（D-22f）

  /** round.pause：先落库（Turn paused、Run CANCELLED），再 abort 适配器——反过来会留下「已 abort、db 还没标」的窗口 */
  async pause(command: CommandRequest<"round.pause">): Promise<Round> {
    const { repo, db, queue, emit, orchestrator } = this.#deps;
    const before = repo.getRound(command.roundId);
    const running = this.#runningRuns(before.id);
    // 已经写出来的部分：从 run_events 的 message_delta 拼回来，和界面流式显示的是同一段
    const partialText = this.#partialTextOf(before.id);

    try {
      await pauseRound(db, queue, { roundId: before.id, partialText });
    } catch (error) {
      throw mapTurnError(error);
    }

    const round = repo.getRound(before.id);
    for (const turn of repo.listTurns(round.id)) {
      if (turn.outcome === "paused") emit({ type: "turn.updated", turn });
    }
    for (const runId of running) emit({ type: "run.updated", run: repo.getRun(runId) });
    emit({ type: "round.updated", round });

    for (const runId of running) orchestrator.cancel(runId);
    return round;
  }

  /** round.end：没答完的 Turn 记 round_ended，轮进待汇总；同样是先落库再 abort */
  async end(command: CommandRequest<"round.end">): Promise<Round> {
    const { repo, db, queue, emit, orchestrator } = this.#deps;
    const before = repo.getRound(command.roundId);
    const running = this.#runningRuns(before.id);
    const partialText = this.#partialTextOf(before.id);

    try {
      await endRound(db, queue, { roundId: before.id, partialText });
    } catch (error) {
      throw mapTurnError(error);
    }

    const round = repo.getRound(before.id);
    for (const turn of repo.listTurns(round.id)) {
      if (turn.outcome === "round_ended") emit({ type: "turn.updated", turn });
    }
    for (const runId of running) emit({ type: "run.updated", run: repo.getRun(runId) });
    emit({ type: "round.updated", round });

    for (const runId of running) orchestrator.cancel(runId);
    return round;
  }

  /** round.resume：内容不变，复用原来的 Snapshot 重新盖章 */
  async resume(command: CommandRequest<"round.resume">): Promise<{ round: Round; batch: ApprovalBatch }> {
    const { repo, db, queue, emit } = this.#deps;
    const round = repo.getRound(command.roundId);
    if (round.state !== "PAUSED") throw new DiscussionError("invalid_state", "这一轮没有暂停");

    const latest = this.#latestTurns(round.id);
    const paused = [...latest.values()].filter((turn) => turn.outcome === "paused");
    const agents = paused.map((turn) => turn.agent);
    if (agents.length === 0) throw new DiscussionError("invalid_state", "暂停时没有人在回答，没什么可恢复的");

    const profiles = agents.map((agentId) => repo.getAgent(agentId));
    const probes = await this.#checkRecipients(agents, "discuss");
    const reuse = new Map<string, BatchModel | null>(
      paused.map((turn) => [turn.agent, repo.getBatchItemByApproval(turn.approvalId)?.model ?? null]),
    );
    const models = this.#selectModels(profiles, "discussion", probes, reuse);

    let created: Awaited<ReturnType<typeof createResumeBatch>>;
    try {
      created = await createResumeBatch(db, queue, {
        roundId: round.id,
        agents,
        models: Object.fromEntries(models),
      });
    } catch (error) {
      throw mapDraftError(error);
    }

    const batch = repo.getBatch(created.batch.id);
    emit({ type: "batch.updated", batch });
    for (const item of batch.items) emit({ type: "approval.updated", approval: repo.getApproval(item.approvalId) });
    for (const turn of repo.listTurns(round.id)) {
      if (turn.batchId === batch.id || turn.supersededBy !== null) emit({ type: "turn.updated", turn });
    }
    return { round: repo.getRound(round.id), batch };
  }

  /**
   * round.supplement：补充总是先写进时间线（human_note）。
   * - next_round：只记下来，下一轮起草时带上
   * - restart_now：打断 targets 里正在答的人，带着补充重答
   * - only：只发给 targets（differsFromOthers = true）
   *
   * 补充内容是**用户写的指令**：走 @room/core 的可信通道（userSupplement），
   * 放在「本轮任务」之后、不可信边界之外；only 模式同时把整批标成 differsFromOthers。
   */
  async supplement(
    command: CommandRequest<"round.supplement">,
  ): Promise<{ note: Message; batch: ApprovalBatch | null }> {
    const { repo, db, queue, emit } = this.#deps;
    const round = repo.getRound(command.roundId);
    if (round.state === "SUMMARIZED" || round.state === "VOIDED") {
      throw new DiscussionError("invalid_state", "这一轮已经结束");
    }
    if (command.mode !== "next_round" && command.targets.length === 0) {
      throw new DiscussionError("validation_failed", "请选择要发给谁");
    }
    if (command.mode !== "next_round" && round.state !== "RUNNING" && round.state !== "AWAITING_SUMMARY") {
      throw new DiscussionError("invalid_state", "现在只能把补充放进下一轮");
    }

    // 「只发言」的两轮之间：DRAFT 时 roundId 记 null（和 mock 一致）
    const note = await repo.addNote(round.projectId, command.content, round.state === "DRAFT" ? null : round.id);
    emit({ type: "message.created", message: note });
    if (command.mode === "next_round") return { note, batch: null };

    const probes = await this.#checkRecipients(command.targets, "discuss");
    const agents = command.targets.map((agentId) => repo.getAgent(agentId));
    const models = this.#selectModels(agents, "discussion", probes);
    const plan = round.planVersionId === null ? null : this.#loadPlan(round.projectId, round.planVersionId);
    const prompts = assembleDiscussionBatch(
      {
        round,
        history: this.#historyWithCurrent(round),
        materials: [],
        plan,
        userSupplement: command.content,
        supplementOnly: command.mode === "only",
        nonce: createNonce(),
      },
      agents.map((profile) => ({ profile, onBehalfOf: null, extraMaterials: [] })),
    );

    const supersede: { oldTurnId: string; agent: string }[] = [];
    let interrupted: { turnId: string; runId: string | null }[] = [];
    if (command.mode === "restart_now") {
      interrupted = (
        await interruptTurns(db, queue, {
          roundId: round.id,
          agents: command.targets,
          partialText: this.#partialTextOf(round.id, command.targets),
        })
      ).interrupted;
      const latest = this.#latestTurns(round.id);
      for (const agent of command.targets) {
        const previous = latest.get(agent);
        if (previous !== undefined) supersede.push({ oldTurnId: previous.id, agent });
      }
    }

    let created: Awaited<ReturnType<typeof createBatchDraft>>;
    try {
      created = await createBatchDraft(db, queue, {
        roundId: round.id,
        kind: "supplement",
        recipients: agents.map((profile, index) => ({
          agent: profile.id,
          prompt: prompts[index]!,
          model: models.get(profile.id) ?? null,
        })),
        compressedRounds: prompts[0]?.compressedRounds ?? [],
        supersede,
      });
    } catch (error) {
      throw mapDraftError(error);
    }

    const batch = repo.getBatch(created.batch.id);
    emit({ type: "batch.updated", batch });
    for (const item of batch.items) emit({ type: "approval.updated", approval: repo.getApproval(item.approvalId) });
    for (const turn of repo.listTurns(round.id)) {
      if (turn.batchId === batch.id || turn.supersededBy !== null) emit({ type: "turn.updated", turn });
    }
    for (const item of interrupted) {
      if (item.runId !== null) emit({ type: "run.updated", run: repo.getRun(item.runId) });
    }
    return { note, batch };
  }

  /** round.retry：单独重试一个结局是 failed / timed_out / absent_quota 的人 */
  async retry(command: CommandRequest<"round.retry">): Promise<ApprovalBatch> {
    const { repo, db, queue, emit } = this.#deps;
    const round = repo.getRound(command.roundId);
    if (round.state === "SUMMARIZED" || round.state === "VOIDED") {
      throw new DiscussionError("invalid_state", "这一轮已经结束");
    }

    const previous = this.#latestTurns(round.id).get(command.agent);
    if (previous === undefined || !["timed_out", "failed", "absent_quota"].includes(previous.outcome)) {
      throw new DiscussionError("invalid_state", "这个人不需要重试");
    }

    // 重试就是用来处理失败 / 超时 / 额度缺席的，所以不按「额度缺席」挡
    const probes = await this.#checkRecipients([command.agent], "discuss", { allowAbsentQuota: true });
    const agent = repo.getAgent(command.agent);
    const previousItem = repo.getBatchItemByApproval(previous.approvalId);
    const reuse = new Map<string, BatchModel | null>([[agent.id, previousItem?.model ?? null]]);
    const models = this.#selectModels([agent], "discussion", probes, reuse);
    const plan = round.planVersionId === null ? null : this.#loadPlan(round.projectId, round.planVersionId);
    const prompts = assembleDiscussionBatch(
      { round, history: this.#historyWithCurrent(round), materials: [], plan, nonce: createNonce() },
      [{ profile: agent, onBehalfOf: null, extraMaterials: [] }],
    );

    let created: Awaited<ReturnType<typeof createBatchDraft>>;
    try {
      created = await createBatchDraft(db, queue, {
        roundId: round.id,
        kind: "retry",
        recipients: [{ agent: agent.id, prompt: prompts[0]!, model: models.get(agent.id) ?? null }],
        compressedRounds: prompts[0]?.compressedRounds ?? [],
        supersede: [{ oldTurnId: previous.id, agent: agent.id }],
      });
    } catch (error) {
      throw mapDraftError(error);
    }

    const batch = repo.getBatch(created.batch.id);
    emit({ type: "batch.updated", batch });
    for (const item of batch.items) emit({ type: "approval.updated", approval: repo.getApproval(item.approvalId) });
    for (const turn of repo.listTurns(round.id)) {
      if (turn.batchId === batch.id || turn.supersededBy !== null) emit({ type: "turn.updated", turn });
    }
    return batch;
  }

  /** round.void：回到某一阶段改方向，记录全部保留 */
  async voidRound(command: CommandRequest<"round.void">): Promise<Round> {
    const { repo, db, queue, emit, orchestrator } = this.#deps;
    const before = repo.getRound(command.roundId);
    const running = this.#runningRuns(before.id);

    let result: Awaited<ReturnType<typeof voidRoundTx>>;
    try {
      result = await voidRoundTx(db, queue, {
        roundId: before.id,
        reason: command.reason,
        partialText: this.#partialTextOf(before.id),
      });
    } catch (error) {
      throw mapDraftError(error);
    }

    const round = repo.getRound(result.round.id);
    for (const turn of repo.listTurns(round.id)) {
      if (turn.outcome === "round_ended") emit({ type: "turn.updated", turn });
    }
    for (const runId of running) emit({ type: "run.updated", run: repo.getRun(runId) });
    for (const planVersionId of result.supersededPlanIds) {
      emit({ type: "plan.updated", plan: repo.getPlan(planVersionId) });
    }
    emit({ type: "round.updated", round });

    for (const runId of running) orchestrator.cancel(runId);
    return round;
  }

  /** round.redraft：修改还没盖章的一轮（任务 / 收件人 / 记录取法） */
  async redraft(command: CommandRequest<"round.redraft">): Promise<{ round: Round; batch: ApprovalBatch }> {
    const { repo, db, queue, emit } = this.#deps;
    const round = repo.getRound(command.roundId);
    if (round.state !== "DRAFT") throw new DiscussionError("invalid_state", "只有还没盖章的一轮可以修改");

    const recipients = command.recipients === undefined ? round.recipients : [...command.recipients];
    const task = command.task ?? round.task;
    const historyMode = command.historyMode ?? round.historyMode;

    const probes = await this.#checkRecipients(recipients, "discuss");
    const agents = recipients.map((agentId) => repo.getAgent(agentId));
    const models = this.#selectModels(agents, "discussion", probes);
    const plan = round.planVersionId === null ? null : this.#loadPlan(round.projectId, round.planVersionId);
    const forPrompt: Round = {
      ...round,
      task,
      taskSource: "human",
      recipients,
      historyMode,
    };
    const prompts = assembleDiscussionBatch(
      {
        round: forPrompt,
        history: repo.discussionHistory(round.projectId, round.index),
        materials: [],
        plan,
        nonce: createNonce(),
      },
      agents.map((profile) => ({ profile, onBehalfOf: null, extraMaterials: [] })),
    );

    let created: Awaited<ReturnType<typeof redraftRound>>;
    try {
      created = await redraftRound(db, queue, {
        roundId: round.id,
        task,
        recipientAgents: recipients,
        historyMode,
        prompts: agents.map((profile, index) => ({
          agent: profile.id,
          prompt: prompts[index]!,
          model: models.get(profile.id) ?? null,
        })),
        compressedRounds: prompts[0]?.compressedRounds ?? [],
      });
    } catch (error) {
      throw mapDraftError(error);
    }

    const updated = repo.getRound(created.round.id);
    const batch = repo.getBatch(created.batch.id);
    emit({ type: "round.updated", round: updated });
    emit({ type: "batch.updated", batch });
    for (const item of batch.items) emit({ type: "approval.updated", approval: repo.getApproval(item.approvalId) });
    for (const turn of repo.listTurnsByBatch(batch.id)) emit({ type: "turn.updated", turn });
    return { round: updated, batch };
  }

  /** note.add：「只发言」，不发给任何 Agent，不用盖章 */
  async addNote(command: CommandRequest<"note.add">): Promise<Message> {
    const { repo, emit } = this.#deps;
    const project = repo.getProject(command.projectId);
    const active = repo.listRounds(project.id).find((round) => ACTIVE_ROUND_STATES.has(round.state));
    const roundId = active !== undefined && active.state !== "DRAFT" ? active.id : null;
    const note = await repo.addNote(project.id, command.content, roundId);
    emit({ type: "message.created", message: note });
    return note;
  }

  /** plan.create：议题还没有任何方案时，用户自己写第一版（v1 DRAFT） */
  async createPlan(command: CommandRequest<"plan.create">): Promise<PlanVersion> {
    const { repo, db, queue, emit } = this.#deps;
    repo.getProject(command.projectId); // 不存在时先报 not_found

    let row: Awaited<ReturnType<typeof createPlanTx>>;
    try {
      row = await createPlanTx(db, queue, {
        projectId: command.projectId,
        content: command.content,
        changeNote: command.changeNote,
      });
    } catch (error) {
      throw mapPlanError(error);
    }

    const plan = repo.getPlan(row.id);
    emit({ type: "plan.updated", plan });
    return plan;
  }

  /** plan.edit：用户自己改方案，生成新的 DRAFT，其它草稿作废 */
  async editPlan(command: CommandRequest<"plan.edit">): Promise<PlanVersion> {
    const { repo, db, queue, emit } = this.#deps;
    let result: Awaited<ReturnType<typeof editPlanTx>>;
    try {
      result = await editPlanTx(db, queue, {
        parentId: command.parentId,
        content: command.content,
        changeNote: command.changeNote,
      });
    } catch (error) {
      throw mapPlanError(error);
    }
    for (const superseded of result.superseded) emit({ type: "plan.updated", plan: repo.getPlan(superseded.id) });
    const plan = repo.getPlan(result.plan.id);
    emit({ type: "plan.updated", plan });
    return plan;
  }

  /** plan.derive：从 FINAL 派生新的 DRAFT（同时作废其它未确认的草稿） */
  async derivePlan(command: CommandRequest<"plan.derive">): Promise<PlanVersion> {
    const { repo, db, queue, emit } = this.#deps;
    let result: Awaited<ReturnType<typeof derivePlanTx>>;
    try {
      result = await derivePlanTx(db, queue, command.planVersionId);
    } catch (error) {
      throw mapPlanError(error);
    }
    for (const superseded of result.superseded) emit({ type: "plan.updated", plan: repo.getPlan(superseded.id) });
    const plan = repo.getPlan(result.plan.id);
    emit({ type: "plan.updated", plan });
    return plan;
  }

  /**
   * 正在跑的 Turn 已经写出来的部分：把该 Run 的 message_delta 按 seq 拼起来，
   * 按 turnId 返回。暂停 / 结束本轮 / 作废 / 打断重答都要带着它落库（0-B 第 3、4、5 行）。
   */
  #partialTextOf(roundId: string, agents?: readonly string[]): Record<string, string> {
    const partial: Record<string, string> = {};
    for (const turn of this.#deps.repo.listTurns(roundId)) {
      if (turn.outcome !== "running" || turn.runId === null) continue;
      if (agents !== undefined && !agents.includes(turn.agent)) continue;
      const rows = this.#deps.db
        .prepare("SELECT payload FROM run_events WHERE run_id = ? AND type = 'message_delta' ORDER BY seq")
        .all(turn.runId) as { payload: string }[];
      const text = rows
        .map((row) => {
          try {
            const payload = JSON.parse(row.payload) as { text?: unknown };
            return typeof payload.text === "string" ? payload.text : "";
          } catch {
            return "";
          }
        })
        .join("");
      if (text !== "") partial[turn.id] = text;
    }
    return partial;
  }

  #runningRuns(roundId: string): string[] {
    return this.#deps.repo
      .listTurns(roundId)
      .filter((turn) => turn.outcome === "running" && turn.runId !== null)
      .map((turn) => turn.runId as string);
  }

  /** 每个人最新一次非汇总发言（按创建顺序覆盖） */
  #latestTurns(roundId: string): Map<string, Turn> {
    const latest = new Map<string, Turn>();
    for (const turn of this.#deps.repo.listTurns(roundId)) {
      if (!turn.isSummary) latest.set(turn.agent, turn);
    }
    return latest;
  }

  /** 总结 / 补充 / 重试时，要让 Agent 看到本轮已经发生的发言 */
  #historyWithCurrent(round: Round): DiscussionHistoryRound[] {
    const history: DiscussionHistoryRound[] = this.#deps.repo.discussionHistory(round.projectId, round.index + 1);
    history.push({
      round,
      messages: this.#deps.repo.listMessagesByRound(round.id),
      turns: this.#deps.repo.listTurns(round.id),
      summary: null,
    });
    return history;
  }

  /**
   * agent.update：新建或修改参与者（契约里没有单独的 create，第一条就靠它建）。
   * 新建时必须有 displayName 和 color；其余字段有默认值。
   */
  async updateAgent(command: CommandRequest<"agent.update">): Promise<AgentProfile> {
    const { repo, emit } = this.#deps;
    const existing = repo.getAgentRow(command.id);
    if (existing === undefined && (command.displayName === undefined || command.color === undefined)) {
      throw new DiscussionError("validation_failed", "新建参与者需要 displayName 和 color");
    }
    if (command.substitute !== undefined && command.substitute !== null) {
      if (command.substitute === command.id) throw new DiscussionError("validation_failed", "不能当自己的替补");
      if (repo.getAgentRow(command.substitute) === undefined) {
        throw new DiscussionError("validation_failed", "替补 " + command.substitute + " 还没有配置");
      }
    }
    if (command.nodeId !== undefined && command.nodeId !== null && repo.getNodeRow(command.nodeId) === undefined) {
      throw new DiscussionError("validation_failed", "节点 " + command.nodeId + " 还没有配置");
    }

    const { type: _type, ...patch } = command;
    const agent = await repo.upsertAgent(patch);
    emit({ type: "agent.status", status: await this.agentStatus(agent.id) });
    return agent;
  }

  /** batch.reject：只作废这一批（Approval / pending Turn 一起），轮状态不变 */
  async reject(command: CommandRequest<"batch.reject">): Promise<ApprovalBatch> {
    const { repo, db, queue, emit } = this.#deps;
    repo.getBatch(command.batchId); // 不存在时先报 not_found
    try {
      await rejectBatch(db, queue, command.batchId, command.reason);
    } catch (error) {
      if (error instanceof TurnError && error.code === "batch_not_ready") {
        throw new DiscussionError("already_decided", "这一批已经处理过了");
      }
      throw error;
    }

    const batch = repo.getBatch(command.batchId);
    for (const item of batch.items) emit({ type: "approval.updated", approval: repo.getApproval(item.approvalId) });
    emit({ type: "batch.updated", batch });
    for (const turn of repo.listTurnsByBatch(batch.id)) {
      if (turn.outcome === "rejected") emit({ type: "turn.updated", turn });
    }
    return batch;
  }

  /** plan.confirm：草稿 → 当前；原来的 CURRENT → SUPERSEDED，两个都要推 plan.updated */
  async confirmPlan(command: CommandRequest<"plan.confirm">): Promise<PlanVersion> {
    const { repo, db, queue, emit } = this.#deps;
    let result: Awaited<ReturnType<typeof confirmPlanTx>>;
    try {
      result = await confirmPlanTx(db, queue, command.planVersionId);
    } catch (error) {
      throw mapPlanError(error);
    }
    for (const superseded of result.superseded) {
      emit({ type: "plan.updated", plan: repo.getPlan(superseded.id) });
    }
    const plan = repo.getPlan(result.plan.id);
    emit({ type: "plan.updated", plan });
    return plan;
  }

  /** plan.finalize：盖章定稿，校验指纹（看的是旧版本就 stale_snapshot） */
  async finalizePlan(command: CommandRequest<"plan.finalize">): Promise<PlanVersion> {
    const { repo, db, queue, emit } = this.#deps;
    let row: Awaited<ReturnType<typeof finalizePlanTx>>;
    try {
      row = await finalizePlanTx(db, queue, {
        planVersionId: command.planVersionId,
        expectedContentHash: command.expectedContentHash,
      });
    } catch (error) {
      throw mapPlanError(error);
    }
    for (const superseded of row.superseded) emit({ type: "plan.updated", plan: repo.getPlan(superseded.id) });
    const plan = repo.getPlan(row.plan.id);
    emit({ type: "plan.updated", plan });
    return plan;
  }

  /** 单个参与者的状态（agent.update 之后推 agent.status 用） */
  async agentStatus(agentId: string): Promise<AgentStatus> {
    const statuses = await this.agentStatuses();
    const found = statuses.find((status) => status.agent === agentId);
    if (found === undefined) throw new DiscussionError("not_found", "参与者 " + agentId + " 不存在");
    return found;
  }

  /**
   * agents.status：参与者现在能不能用。和 round.draft 的判断尽量一致，但**不抛错**，
   * 只把状态算出来给界面显示。
   *
   * 1A 拿不到额度 / 模型 / 上下文用量，这些字段一律 null（界面显示「未知」），不猜。
   */
  async agentStatuses(): Promise<AgentStatus[]> {
    const { repo, settings } = this.#deps;
    const agents = repo.listAgents();

    const targets: { nodeId: string; baseUrl: string; token: string; profileId: string }[] = [];
    for (const agent of agents) {
      if (agent.nodeId === null || agent.profileId === null) continue;
      const node = repo.getNodeRow(agent.nodeId);
      const credential = settings.getNode(agent.nodeId);
      if (node === undefined || node.base_url === null || credential === null || credential.baseUrl !== node.base_url) {
        continue;
      }
      targets.push({
        nodeId: agent.nodeId,
        baseUrl: credential.baseUrl,
        token: credential.token,
        profileId: agent.profileId,
      });
    }

    // 同一个节点只探一次
    const byNode = new Map<string, (typeof targets)[number]>();
    for (const target of targets) if (!byNode.has(target.nodeId)) byNode.set(target.nodeId, target);
    const probes = new Map<string, NodeProbeResult>();
    await Promise.all(
      [...byNode.values()].map(async (target) => {
        probes.set(
          target.nodeId,
          await this.#probe({ baseUrl: target.baseUrl, token: target.token, profileId: target.profileId }),
        );
      }),
    );

    const updatedAt = new Date().toISOString();
    return agents.map((agent) => ({
      agent: agent.id,
      availability: this.#availabilityOf(agent, probes),
      // 1A 不知道计费方式 / 额度 / 模型 / 上下文，全部 null，界面显示「未知」
      billing: "unknown",
      fiveHour: null,
      weekly: null,
      balance: null,
      contextUsedPercent: null,
      compactions: null,
      model: null,
      effort: null,
      updatedAt,
    }));
  }

  #availabilityOf(agent: AgentProfile, probes: Map<string, NodeProbeResult>): AgentStatus["availability"] {
    if (agent.nodeId === null || agent.profileId === null) return "unconfigured";
    if (agent.pausedByUser) return "paused_by_user";

    const latest = this.#deps.repo.latestTurnOutcomeGlobal(agent.id);
    if (latest !== null && latest.outcome === "absent_quota" && this.#isRecentQuotaAbsence(latest.finishedAt)) {
      return "absent_quota";
    }

    const node = this.#deps.repo.getNodeRow(agent.nodeId);
    const credential = this.#deps.settings.getNode(agent.nodeId);
    if (node === undefined || node.base_url === null || credential === null || credential.baseUrl !== node.base_url) {
      return "unconfigured";
    }

    const probe = probes.get(agent.nodeId);
    if (probe === undefined || !probe.reachable || !probe.profiles.includes(agent.profileId)) return "offline";
    return "available";
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
   * C-40：按参与者的模型设置和节点上报的 profileModels 定下这一批的模型。
   * 规则见 @room/schemas 的 AgentModelSettings 注释；reuse 用于重试 / 恢复沿用原模型。
   */
  #selectModels(
    agents: readonly AgentProfile[],
    occasion: RunOccasion,
    probes: Map<string, NodeProbeResult>,
    reuse?: ReadonlyMap<string, BatchModel | null>,
  ): Map<string, BatchModel | null> {
    const selected = new Map<string, BatchModel | null>();
    for (const agent of agents) {
      const models =
        agent.nodeId !== null && agent.profileId !== null
          ? probes.get(agent.nodeId)?.profileModels?.find((profile) => profile.profileId === agent.profileId)?.models
          : undefined;

      const original = reuse?.get(agent.id);
      if (
        original !== undefined &&
        original !== null &&
        models !== undefined &&
        models.some(
          (option) =>
            option.id === original.model &&
            (original.effort === null || option.efforts.some((level) => level.id === original.effort)),
        )
      ) {
        selected.set(agent.id, original);
        continue;
      }

      selected.set(agent.id, this.#selectOneModel(agent, occasion, models));
    }
    return selected;
  }

  #selectOneModel(
    agent: AgentProfile,
    occasion: RunOccasion,
    models: readonly import("@room/schemas").ModelOption[] | undefined,
  ): BatchModel | null {
    // 1. 跟随 profile：没报 profileModels / 没有这个 profile / models 为空 / 首选为 null
    if (models === undefined || models.length === 0 || agent.modelSettings.primaryModel === null) return null;

    const primary = models.find((option) => option.id === agent.modelSettings.primaryModel);
    const chosen =
      primary ??
      (agent.modelSettings.fallbackModel === null
        ? undefined
        : models.find((option) => option.id === agent.modelSettings.fallbackModel));
    if (chosen === undefined) {
      const wanted = [agent.modelSettings.primaryModel, agent.modelSettings.fallbackModel]
        .filter((id): id is string => id !== null)
        .join(" / ");
      throw new DiscussionError(
        "agent_unavailable",
        agent.displayName + " 的模型不可用：" + wanted + " 都不在节点上（profile " + (agent.profileId ?? "?") + "）",
      );
    }

    let effort: string | null;
    let effortSource: BatchModel["effortSource"];
    if (chosen.efforts.length === 0) {
      effort = null;
      effortSource = "none";
    } else {
      const configured = agent.modelSettings.effort[occasion];
      if (configured !== null && chosen.efforts.some((level) => level.id === configured)) {
        effort = configured;
        effortSource = "configured";
      } else {
        effort = chosen.defaultEffort ?? null;
        effortSource = "node_default";
      }
    }

    return {
      model: chosen.id,
      effort,
      usedFallback: primary === undefined,
      effortSource,
    };
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
   * - 节点的 Token 没有配置：不发（多节点各自的 Token 存在设置文件里，D-22c）
   */
  async #checkRecipients(
    agentIds: readonly string[],
    need: AvailabilityNeed,
    options: { allowAbsentQuota?: boolean } = {},
  ): Promise<Map<string, NodeProbeResult>> {
    const { repo, settings } = this.#deps;
    const pending: PendingRecipient[] = [];
    /** 每个节点自己的凭据（地址 + 解密后的 Token），同一个节点只取一次 */
    const credentials = new Map<string, { baseUrl: string; token: string }>();

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

      // 额度按账号算：所有议题里最新一次发言（含汇总）都算数。
      // 重试自己就是用来处理失败 / 缺席的，所以 round.retry 传 allowAbsentQuota 跳过这一条。
      const latest = repo.latestTurnOutcomeGlobal(agentId);
      if (
        options.allowAbsentQuota !== true &&
        latest !== null &&
        latest.outcome === "absent_quota" &&
        this.#isRecentQuotaAbsence(latest.finishedAt)
      ) {
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
      const credential = settings.getNode(nodeId);
      if (credential === null || credential.baseUrl !== node.base_url) {
        throw new DiscussionError("agent_unavailable", displayName + " 所在的节点 " + nodeId + " 的 Token 还没有配置");
      }
      credentials.set(nodeId, credential);

      pending.push({ displayName, nodeId, baseUrl: node.base_url, profileId });
    }

    if (pending.length === 0) return new Map();

    // 同一个节点只探一次；不同节点之间并发
    const byNode = new Map<string, PendingRecipient[]>();
    for (const item of pending) byNode.set(item.nodeId, [...(byNode.get(item.nodeId) ?? []), item]);

    const probes = new Map<string, NodeProbeResult>();
    await Promise.all(
      [...byNode.values()].map(async (items) => {
        const first = items[0]!;
        const credential = credentials.get(first.nodeId)!;
        probes.set(
          first.nodeId,
          await this.#probe({ baseUrl: first.baseUrl, token: credential.token, profileId: first.profileId }),
        );
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

    return probes;
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
      ? {
          reachable: true,
          profiles: result.health.profiles,
          ...(result.health.profileModels === undefined ? {} : { profileModels: result.health.profileModels }),
        }
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
    case "model_mismatch":
      return new DiscussionError("stale_snapshot", error.message);
    default:
      return new DiscussionError("invalid_state", error.message);
  }
}

function mapPlanError(error: unknown): unknown {
  if (!(error instanceof PlanError)) return error;
  switch (error.code) {
    case "plan_not_found":
      return new DiscussionError("not_found", error.message);
    case "hash_mismatch":
      return new DiscussionError("stale_snapshot", "方案内容和你看到的不一致，请重新打开");
    case "plan_exists":
      return new DiscussionError("invalid_state", "这个议题已经有方案版本了，请用「我来改」");
    case "plan_not_latest":
      return new DiscussionError("invalid_state", "已经有更新的方案版本了，请从最新版本派生，或先确认/定稿它");
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
    case "round_not_draft":
    case "round_not_paused":
    case "round_not_active":
    case "turn_not_retryable":
      return new DiscussionError("invalid_state", error.message);
    default:
      return new DiscussionError("internal", error.message);
  }
}

function mapTurnError(error: unknown): unknown {
  if (error instanceof TurnError && error.code === "round_not_active") {
    return new DiscussionError("invalid_state", error.message);
  }
  return error;
}
