import {
  assembleDiscussionBatch,
  assembleSummaryPrompt,
  createNonce,
  type DiscussionHistoryRound,
  type DiscussionMaterial,
} from "@room/core";
import {
  approveBatch,
  BatchApproveError,
  getChatMessage,
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
  listBatchItems,
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
  QueryRequest,
  Round,
  RunOccasion,
  Turn,
  ChatMessage,
} from "@room/schemas";
import { isExcludedFromContext } from "@room/schemas";
import { renderChatMaterial } from "./chat-material";
import type { DiscussionSettlement, RunOrchestrator } from "./orchestrator";
import { agentActivity, type AgentActivityPage } from "./activity";
import { QuotaService, quotaKeyOf, type ProfileQuotaRead } from "./quota";
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

/**
 * 节点对 StartRunRequest.snapshot.content 的上限（remote-protocol.ts）。
 * 材料接近上限时，边界标签、本轮任务和本轮历史会把最终 Prompt 顶过这个数：在起草时明确报错，
 * 而不是把请求发给节点再被拒。
 */
const MAX_PROMPT_CHARS = 2_000_000;

function assertPromptFits(prompts: readonly { content: string }[]): void {
  for (const prompt of prompts) {
    if (prompt.content.length > MAX_PROMPT_CHARS) {
      throw new DiscussionError(
        "validation_failed",
        "这一轮的 Prompt 超过节点上限（2,000,000 字），请把材料、任务或补充改短",
      );
    }
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
  /** D-32：读节点额度（GET /v1/profiles/:id/quota）；测试注入假的，默认真打节点 */
  readonly quota?: QuotaService;
}

type AvailabilityNeed = "discuss" | "summarize";

/**
 * 额度缺席只在 5 小时内算数：过了这段时间可能是额度重置了，不能一直挡着。
 * 1A 还没有真正的额度接口，这是按「上一次发言的结局」做的近似。
 */
/** D-32：没有注入时的默认额度读取器（30 秒缓存、2 秒超时） */
const defaultQuota = new QuotaService();

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

    // D-32：先把收件人过一遍（谁能答、谁缺席、谁替谁）；后面拼 Prompt 用的就是「实际收件的人」
    const resolved = await this.#resolveSubstitutions({
      recipients: command.recipients,
      explicit: command.substitutes,
      auto: command.substitutes === undefined,
    });
    const probes = resolved.probes;
    const agents: AgentProfile[] = resolved.agents;
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

    const materials = this.#materialsFor(project.id);
    const prompts = assembleDiscussionBatch(
      {
        round: roundForPrompt,
        history: repo.discussionHistory(project.id, roundIndex),
        materials: materials.materials,
        plan,
        nonce: createNonce(),
      },
      resolved.batch.map((item) => ({ profile: item.profile, onBehalfOf: item.onBehalfOf, extraMaterials: [] })),
    );
    assertPromptFits(prompts);

    let created: Awaited<ReturnType<typeof createRoundDraft>>;
    try {
      created = await createRoundDraft(db, queue, {
        projectId: project.id,
        roundId,
        recipients: resolved.batch.map((item, index) => ({
          agent: item.agent,
          onBehalfOf: item.onBehalfOf,
          prompt: prompts[index]!,
          model: models.get(item.agent) ?? null,
        })),
        // 这一轮「本来发给谁」仍是用户挑的收件人（缺席的那位也在里面）
        roundRecipients: command.recipients,
        task: command.task,
        taskSource: command.taskSource,
        planVersionId: command.planVersionId,
        historyMode: command.historyMode,
        compressedRounds: prompts[0]?.compressedRounds ?? [],
        chatMaterialSourceIds: materials.sourceMessageIds,
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

    const materials = this.#materialsFor(round.projectId);
    const prompt = assembleSummaryPrompt(
      { round, history, materials: materials.materials, plan, nonce: createNonce() },
      { profile: summarizer, onBehalfOf: null, extraMaterials: [] },
    );
    assertPromptFits([prompt]);

    let created: Awaited<ReturnType<typeof createSummaryDraft>>;
    try {
      created = await createSummaryDraft(db, queue, {
        roundId: round.id,
        recipients: [{ agent: summarizer.id, prompt, model: summarizerModel }],
        compressedRounds: prompt.compressedRounds,
        chatMaterialSourceIds: materials.sourceMessageIds,
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
    const materials = this.#materialsFor(round.projectId);
    const prompts = assembleDiscussionBatch(
      {
        round,
        history: this.#historyWithCurrent(round),
        materials: materials.materials,
        plan,
        userSupplement: command.content,
        supplementOnly: command.mode === "only",
        nonce: createNonce(),
      },
      agents.map((profile) => ({ profile, onBehalfOf: null, extraMaterials: [] })),
    );
    // 注意：补充 note 已经先落库了（和 agent_unavailable 一样：批次没建成、补充留在时间线）。
    // 所以这里超限也遵循同一个语义，不回滚 note——改这一点属于产品语义，不在这个修复里动。
    assertPromptFits(prompts);

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
        chatMaterialSourceIds: materials.sourceMessageIds,
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
    // 已经开始重试了：再点一次会派第二个替补替他答，直接拒（C酱 #158 必须改 1）
    if (previous.supersededBy !== null) {
      throw new DiscussionError("invalid_state", "这一位已经在重试了");
    }

    // C-36 / D-32：带 substitute = 改由这位代他答（典型：答到一半额度用完）。
    // 重试自己就是用来处理失败 / 超时 / 额度缺席的，所以被重试的人不按「额度缺席」挡；但替补必须现在真的能答
    if (command.substitute !== undefined) {
      if (command.substitute === command.agent) {
        throw new DiscussionError("validation_failed", "不能让自己替自己");
      }
      if (previous.onBehalfOf !== null) {
        throw new DiscussionError("validation_failed", "他本来就是替补，不能再找替补（不做替补链）");
      }
    }
    const runner = repo.getAgent(command.substitute ?? command.agent);
    const probes =
      command.substitute === undefined
        ? await this.#checkRecipients([command.agent], "discuss", { allowAbsentQuota: true })
        : await this.#checkSubstituteForRound(round, runner);
    const agent = repo.getAgent(command.agent);
    const previousItem = repo.getBatchItemByApproval(previous.approvalId);
    const reuse = new Map<string, BatchModel | null>([[runner.id, previousItem?.model ?? null]]);
    const models = this.#selectModels([runner], "discussion", probes, reuse);
    const plan = round.planVersionId === null ? null : this.#loadPlan(round.projectId, round.planVersionId);
    const materials = this.#materialsFor(round.projectId);
    const prompts = assembleDiscussionBatch(
      { round, history: this.#historyWithCurrent(round), materials: materials.materials, plan, nonce: createNonce() },
      [{ profile: runner, onBehalfOf: command.substitute === undefined ? null : agent.id, extraMaterials: [] }],
    );
    assertPromptFits(prompts);

    let created: Awaited<ReturnType<typeof createBatchDraft>>;
    try {
      created = await createBatchDraft(db, queue, {
        roundId: round.id,
        kind: "retry",
        recipients: [
          {
            agent: runner.id,
            onBehalfOf: command.substitute === undefined ? null : agent.id,
            prompt: prompts[0]!,
            model: models.get(runner.id) ?? null,
          },
        ],
        compressedRounds: prompts[0]?.compressedRounds ?? [],
        // 新 Turn 的 agent 是替补（runner），supersede 必须按他找，否则旧 Turn 接不上（C酱 #158 必须改 1）
        supersede: [{ oldTurnId: previous.id, agent: runner.id }],
        chatMaterialSourceIds: materials.sourceMessageIds,
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

  /** D-44 / C-37a：秘书控制台的「正在答什么 / 历史」（讨论 Turn + 聊天回答位） */
  async activity(command: QueryRequest<"agents.activity">): Promise<AgentActivityPage> {
    const { repo, db } = this.#deps;
    if (repo.getAgentRow(command.agent) === undefined) {
      throw new DiscussionError("not_found", "参与者 " + command.agent + " 不存在");
    }
    return agentActivity(db, command.agent, { before: command.before, limit: command.limit });
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

    // D-32：substitutes 省略 = 沿用旧批次的替补（按 onBehalfOf 读回；被改掉的人那一对丢掉）
    const explicit =
      command.substitutes ?? (await this.#carriedOverSubstitutions(round.id, recipients));
    const resolved = await this.#resolveSubstitutions({ recipients, explicit, auto: false });
    const probes = resolved.probes;
    const agents: AgentProfile[] = resolved.agents;
    const models = this.#selectModels(agents, "discussion", probes);
    const plan = round.planVersionId === null ? null : this.#loadPlan(round.projectId, round.planVersionId);
    const forPrompt: Round = {
      ...round,
      task,
      taskSource: "human",
      recipients,
      historyMode,
    };
    const materials = this.#materialsFor(round.projectId);
    const prompts = assembleDiscussionBatch(
      {
        round: forPrompt,
        history: repo.discussionHistory(round.projectId, round.index),
        materials: materials.materials,
        plan,
        nonce: createNonce(),
      },
      resolved.batch.map((item) => ({ profile: item.profile, onBehalfOf: item.onBehalfOf, extraMaterials: [] })),
    );
    assertPromptFits(prompts);

    let created: Awaited<ReturnType<typeof redraftRound>>;
    try {
      created = await redraftRound(db, queue, {
        roundId: round.id,
        task,
        recipientAgents: recipients,
        historyMode,
        prompts: resolved.batch.map((item, index) => ({
          agent: item.agent,
          onBehalfOf: item.onBehalfOf,
          prompt: prompts[index]!,
          model: models.get(item.agent) ?? null,
        })),
        compressedRounds: prompts[0]?.compressedRounds ?? [],
        chatMaterialSourceIds: materials.sourceMessageIds,
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
    // D-32：额度从节点读（C-36 的端点）；读不到的项是 null，不猜、不写 0
    const quotas = await this.#quotaReadsFor(agents);
    return agents.map((agent) => {
      const state = this.#availabilityOf(agent, probes, quotas);
      const quota = state.quota?.quota ?? null;
      const billing: AgentStatus["billing"] =
        quota === null
          ? "unknown"
          : quota.balance !== null && quota.balance !== undefined
            ? "api"
            : quota.fiveHour !== null || quota.weekly !== null
              ? "subscription"
              : "unknown";
      return {
        agent: agent.id,
        availability: state.availability,
        billing,
        fiveHour: quota?.fiveHour ?? null,
        weekly: quota?.weekly ?? null,
        // C-36：节点不报「本月消耗」，先一律 null（界面显示「暂不可用」）
        balance:
          quota?.balance === undefined || quota?.balance === null
            ? null
            : { amount: quota.balance.amount, currency: quota.balance.currency, spentThisMonth: null },
        contextUsedPercent: null,
        compactions: null,
        model: null,
        effort: null,
        updatedAt,
      };
    });
  }

  /**
   * D-32：一位参与者「本来要答的人」的状态（availability + 给用户看的理由 + 读到的额度）。
   * 额度口径按 C-36：
   * - 读到 exhausted（任一窗口 ≥100% 或余额 ≤0）→ absent_quota
   * - 最近一次 Run 以 quota_exhausted 结束、之后还没读到 **ok** 的额度 → absent_quota（粘滞；读 unknown 不清）
   * - 读不到（unknown）、也没有那样的 Run → 不算缺席
   */
  #availabilityOf(
    agent: AgentProfile,
    probes: Map<string, NodeProbeResult>,
    quotas: Map<string, ProfileQuotaRead | null>,
  ): { availability: AgentStatus["availability"]; reason: string; quota: ProfileQuotaRead | null } {
    const quota = quotas.get(agent.id) ?? null;
    const name = agent.displayName;
    if (agent.nodeId === null || agent.profileId === null) {
      return { availability: "unconfigured", reason: name + " 还没有配置节点或 profile", quota };
    }
    if (agent.pausedByUser) return { availability: "paused_by_user", reason: name + " 被手动暂停了", quota };
    if (quota?.state === "exhausted") return { availability: "absent_quota", reason: name + " 额度用尽", quota };

    const latest = this.#deps.repo.latestTurnOutcomeGlobal(agent.id);
    if (latest !== null && latest.outcome === "absent_quota" && this.#stickyQuotaAbsence(agent, latest.finishedAt)) {
      // C酱 #158 建议 2：节点上那个 profile 没配额度来源（404）时，读不到额度就会一直算缺席，提示一下
      const hint = quota?.notConfigured === true ? "（这个节点没配额度来源，读不到额度就会一直算缺席）" : "";
      return { availability: "absent_quota", reason: name + " 额度用尽（缺席）" + hint, quota };
    }

    const node = this.#deps.repo.getNodeRow(agent.nodeId);
    if (node === undefined || node.base_url === null) {
      return { availability: "unconfigured", reason: name + " 所在的节点 " + agent.nodeId + " 还没有配置地址", quota };
    }
    const credential = this.#deps.settings.getNode(agent.nodeId);
    if (credential === null || credential.baseUrl !== node.base_url) {
      return { availability: "unconfigured", reason: name + " 所在的节点 " + agent.nodeId + " 的 Token 还没有配置", quota };
    }

    const probe = probes.get(agent.nodeId);
    if (probe === undefined || !probe.reachable) {
      return {
        availability: "offline",
        reason: name + " 所在的节点离线" + (probe?.message === undefined ? "" : "：" + probe.message),
        quota,
      };
    }
    if (!probe.profiles.includes(agent.profileId)) {
      return { availability: "offline", reason: name + " 的 profile " + agent.profileId + " 不在节点上", quota };
    }
    return { availability: "available", reason: "", quota };
  }

  /** C-36 的粘滞缺席：上次 Run 之后没有读到 ok 就还缺席。时间戳缺失时放行（不挡人） */
  #stickyQuotaAbsence(agent: AgentProfile, finishedAt: string | null): boolean {
    if (finishedAt === null) return false;
    const at = Date.parse(finishedAt);
    if (!Number.isFinite(at)) return false;
    const target = this.#quotaTargetOf(agent);
    if (target === null) return true;
    return this.#quotaService().lastOkAt(quotaKeyOf(target)) <= at;
  }

  #quotaService(): QuotaService {
    return this.#deps.quota ?? defaultQuota;
  }

  /** 讨论用 profile 的额度读取目标（节点地址 + Token + profileId）；没配置返回 null */
  #quotaTargetOf(agent: AgentProfile): { baseUrl: string; token: string; profileId: string } | null {
    if (agent.nodeId === null || agent.profileId === null) return null;
    const node = this.#deps.repo.getNodeRow(agent.nodeId);
    const credential = this.#deps.settings.getNode(agent.nodeId);
    if (node === undefined || node.base_url === null || credential === null || credential.baseUrl !== node.base_url) {
      return null;
    }
    return { baseUrl: node.base_url, token: credential.token, profileId: agent.profileId };
  }

  /** 每人一份额度（同一个 profile 只读一次）；读不到记 null，不当成用完 */
  async #quotaReadsFor(agents: readonly AgentProfile[]): Promise<Map<string, ProfileQuotaRead | null>> {
    const service = this.#quotaService();
    const byKey = new Map<string, Promise<ProfileQuotaRead | null>>();
    const reads = new Map<string, ProfileQuotaRead | null>();
    const pending: { agentId: string; promise: Promise<ProfileQuotaRead | null> }[] = [];
    for (const agent of agents) {
      const target = this.#quotaTargetOf(agent);
      if (target === null) {
        reads.set(agent.id, null);
        continue;
      }
      const key = quotaKeyOf(target);
      if (!byKey.has(key)) byKey.set(key, service.read(target).catch(() => null));
      pending.push({ agentId: agent.id, promise: byKey.get(key)! });
    }
    // 不同 profile 的额度一起等（每个最多 2 秒，串行会累加；都是缓存过的读）
    await Promise.all([...byKey.values()]);
    for (const item of pending) reads.set(item.agentId, await item.promise);
    return reads;
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

  /**
   * C-34 / D-31c：这个议题从聊天转来的初始材料。
   * ADR-004：议题材料**每轮都带**（不只第 1 轮），和附件一样进不可信边界。
   *
   * 材料里存的是转议题那一刻的文本，但来源消息之后可能被撤回（ADR-003：撤回之后新建的 Prompt
   * 不再带它）。所以每次拼 Prompt 都按 chat_message_ids 重读来源消息，把已排除的挑掉再重新整理；
   * 全被撤回了就不带这份材料。旧 Snapshot 不变（它存的是当时的文本）。
   */
  #materialsFor(projectId: string): { materials: DiscussionMaterial[]; sourceMessageIds: string[] } {
    const { db } = this.#deps;
    const rows = db
      .prepare(
        "SELECT m.chat_message_ids AS messageIds, m.content AS content, m.conversation_id AS conversationId, c.title AS title " +
          "FROM messages m LEFT JOIN conversations c ON c.id = m.conversation_id " +
          "WHERE m.project_id = ? AND m.kind = 'chat_material' ORDER BY m.created_at, m.id",
      )
      .all(projectId) as { messageIds: string; content: string; conversationId: string; title: string | null }[];

    const agents = new Map(this.#deps.repo.listAgents().map((agent) => [agent.id, agent]));
    const displayNameOf = (agentId: string) => agents.get(agentId)?.displayName ?? agentId;
    const parentOf = (messageId: string) => {
      const message = getChatMessage(db, messageId);
      return message !== null && message.sender === "user" ? message : undefined;
    };

    const materials: DiscussionMaterial[] = [];
    const sourceMessageIds: string[] = [];
    for (const row of rows) {
      const ids = JSON.parse(row.messageIds) as string[];
      const found = ids
        .map((id) => getChatMessage(db, id))
        .filter((message): message is ChatMessage => message !== null);
      // 来源消息一条都读不到（理论上不会发生；聊天消息不删）就退回转议题时存的文本，别把材料整个丢掉
      if (found.length === 0) {
        materials.push({ name: "聊天记录（" + (row.title ?? row.conversationId) + "）", content: row.content });
        continue;
      }
      const kept = found.filter((message) => !isExcludedFromContext(message, parentOf));
      if (kept.length === 0) continue;
      for (const message of kept) sourceMessageIds.push(message.id);
      const ordered = kept.sort((left, right) =>
        left.createdAt === right.createdAt ? (left.id < right.id ? -1 : 1) : left.createdAt < right.createdAt ? -1 : 1,
      );
      materials.push({
        name: "聊天记录（" + (row.title ?? row.conversationId) + "）",
        content: renderChatMaterial(ordered, displayNameOf),
      });
    }
    // 这些消息在写入 Snapshot 的事务里还要再核一次：拼 Prompt 到拿到写锁之间可能被撤回
    return { materials, sourceMessageIds: [...new Set(sourceMessageIds)] };
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
  /**
   * D-32 / C-36：把「用户挑的收件人」变成「实际收件的人」。
   *
   * - 每位收件人必须能答：`available` 留着；`absent_quota` 按替补处理；其它不可用直接 agent_unavailable
   * - 替补必须：不是收件人、开了「参与讨论」、现在能答、不成链（一个人一轮只代一个人、不做替补链）
   * - `explicit` 传了（可以是空数组）就按它来；`auto` 为 true 时对缺席的人按 `AgentProfile.substitute` 自动找
   * - 返回的 `batch` 是真正要建 Snapshot / Turn 的人：`onBehalfOf` 记被替的人
   */
  async #resolveSubstitutions(input: {
    recipients: readonly string[];
    explicit: readonly { absent: string; substitute: string }[] | undefined;
    auto: boolean;
  }): Promise<{
    batch: { agent: string; onBehalfOf: string | null; profile: AgentProfile }[];
    pairs: { absent: string; substitute: string }[];
    probes: Map<string, NodeProbeResult>;
    agents: AgentProfile[];
  }> {
    const { repo } = this.#deps;
    const recipientSet = new Set(input.recipients);
    // 不存在的参与者：和 #checkRecipients 一样报 agent_unavailable（不是 not_found）
    const agents = input.recipients.map((agentId) => {
      if (repo.getAgentRow(agentId) === undefined) {
        throw new DiscussionError("agent_unavailable", "参与者 " + agentId + " 还没有配置");
      }
      return repo.getAgent(agentId);
    });
    const { probes, quotas } = await this.#probeAndQuota(agents);

    const absentList: AgentProfile[] = [];
    /** 缺席的理由（带「节点没配额度来源」这类提示），后面报错直接用 */
    const absentReasons = new Map<string, string>();
    for (const agent of agents) {
      const state = this.#availabilityOf(agent, probes, quotas);
      if (state.availability === "available") continue;
      if (state.availability !== "absent_quota") {
        throw new DiscussionError("agent_unavailable", state.reason);
      }
      absentList.push(agent);
      absentReasons.set(agent.id, state.reason);
    }

    // 先定「谁替谁」
    let pairs: { absent: string; substitute: string }[];
    if (input.explicit !== undefined) {
      pairs = [...input.explicit];
    } else if (input.auto && absentList.length > 0) {
      pairs = [];
      for (const absent of absentList) {
        const substitute = absent.substitute;
        if (substitute === null) {
          throw new DiscussionError(
            "agent_unavailable",
            (absentReasons.get(absent.id) ?? absent.displayName + " 额度用尽（缺席）") + "，也没有设替补",
          );
        }
        pairs.push({ absent: absent.id, substitute });
      }
    } else {
      pairs = [];
    }

    // 缺席的人必须都有替补，否则这一轮发不出去（契约：那个人照旧 agent_unavailable）
    for (const absent of absentList) {
      if (!pairs.some((pair) => pair.absent === absent.id)) {
        const reason = absentReasons.get(absent.id) ?? absent.displayName + " 额度用尽（缺席）";
        throw new DiscussionError("agent_unavailable", input.auto ? reason + "，也没有设替补" : reason);
      }
    }

    // 校验每一对
    const usedSubstitutes = new Set<string>();
    const absentIds = new Set(pairs.map((pair) => pair.absent));
    for (const pair of pairs) {
      if (!recipientSet.has(pair.absent)) {
        throw new DiscussionError("validation_failed", "替补的「被代答者」" + pair.absent + " 不在收件人里");
      }
      if (recipientSet.has(pair.substitute)) {
        throw new DiscussionError("validation_failed", "替补 " + pair.substitute + " 已经在收件人里（一个人一轮只有一个 Turn）");
      }
      if (absentIds.has(pair.substitute)) {
        throw new DiscussionError("validation_failed", "替补 " + pair.substitute + " 自己也是缺席的人（不做替补链）");
      }
      if (usedSubstitutes.has(pair.substitute)) {
        throw new DiscussionError("validation_failed", "替补 " + pair.substitute + " 一轮只代一个人");
      }
      usedSubstitutes.add(pair.substitute);
    }

    // 替补本人也要能答
    const substitutes = pairs.map((pair) => repo.getAgent(pair.substitute));
    for (const substitute of substitutes) {
      if (!substitute.canDiscuss) {
        throw new DiscussionError("agent_unavailable", substitute.displayName + " 没有开启「参与讨论」，不能当替补");
      }
    }
    const substituteStates = await this.#probeAndQuota(substitutes);
    for (const [index, substitute] of substitutes.entries()) {
      const state = this.#availabilityOf(substitute, substituteStates.probes, substituteStates.quotas);
      if (state.availability !== "available") {
        throw new DiscussionError(
          "agent_unavailable",
          substitute.displayName + " 现在不能当替补（" + state.reason + "）",
        );
      }
    }
    for (const [nodeId, probe] of substituteStates.probes) probes.set(nodeId, probe);

    const batch = [
      ...agents
        .filter((agent) => !absentIds.has(agent.id))
        .map((agent) => ({ agent: agent.id, onBehalfOf: null, profile: agent })),
      ...pairs.map((pair) => ({
        agent: pair.substitute,
        onBehalfOf: pair.absent,
        profile: repo.getAgent(pair.substitute),
      })),
    ];
    return { batch, pairs, probes, agents: batch.map((item) => item.profile) };
  }

  /**
   * D-32：redraft 省略 substitutes 时沿用旧批次里的替补（按 onBehalfOf 读回）。
   * 被改掉的人（absent 已不在新收件人里）和「替补后来自己进了收件人」的那一对都丢掉。
   */
  async #carriedOverSubstitutions(
    roundId: string,
    recipients: readonly string[],
  ): Promise<{ absent: string; substitute: string }[]> {
    const row = this.#deps.db
      .prepare("SELECT id FROM batches WHERE round_id = ? AND state IN ('DRAFT', 'READY_FOR_REVIEW') ORDER BY created_at DESC LIMIT 1")
      .get(roundId) as { id: string } | undefined;
    if (row === undefined) return [];
    const wanted = new Set(recipients);
    return listBatchItems(this.#deps.db, row.id)
      .filter((item) => item.onBehalfOf !== null)
      .map((item) => ({ absent: item.onBehalfOf as string, substitute: item.recipient }))
      .filter((pair) => wanted.has(pair.absent) && !wanted.has(pair.substitute));
  }

  /** D-32：round.retry 的替补要能答、而且这一轮还没轮到过他（一个人一轮只有一个 Turn） */
  async #checkSubstituteForRound(round: Round, substitute: AgentProfile): Promise<Map<string, NodeProbeResult>> {
    if (!substitute.canDiscuss) {
      throw new DiscussionError("agent_unavailable", substitute.displayName + " 没有开启「参与讨论」，不能当替补");
    }
    if (this.#latestTurns(round.id).has(substitute.id)) {
      throw new DiscussionError("validation_failed", substitute.displayName + " 这一轮已经答过了，不能当替补");
    }
    const { probes, quotas } = await this.#probeAndQuota([substitute]);
    const state = this.#availabilityOf(substitute, probes, quotas);
    if (state.availability !== "available") {
      throw new DiscussionError("agent_unavailable", substitute.displayName + " 现在不能当替补（" + state.reason + "）");
    }
    return probes;
  }

  async #checkRecipients(
    agentIds: readonly string[],
    need: AvailabilityNeed,
    options: { allowAbsentQuota?: boolean } = {},
  ): Promise<Map<string, NodeProbeResult>> {
    const { repo } = this.#deps;
    const agents: AgentProfile[] = [];
    for (const agentId of agentIds) {
      const row = repo.getAgentRow(agentId);
      if (row === undefined) throw new DiscussionError("agent_unavailable", "参与者 " + agentId + " 还没有配置");
      const displayName = row["display_name"] as string;
      if (need === "discuss" && row["can_discuss"] !== 1) {
        throw new DiscussionError("agent_unavailable", displayName + " 没有开启「参与讨论」");
      }
      if (need === "summarize" && row["can_summarize"] !== 1) {
        throw new DiscussionError("agent_unavailable", displayName + " 没有开启「可以做汇总」");
      }
      agents.push(repo.getAgent(agentId));
    }

    const { probes, quotas } = await this.#probeAndQuota(agents);
    for (const agent of agents) {
      const state = this.#availabilityOf(agent, probes, quotas);
      if (state.availability === "available") continue;
      // 重试自己就是用来处理失败 / 额度缺席的：round.retry 传 allowAbsentQuota 跳过这一条
      if (state.availability === "absent_quota" && options.allowAbsentQuota === true) continue;
      throw new DiscussionError("agent_unavailable", agent.displayName + " " + state.reason);
    }
    return probes;
  }

  /** D-32：一批人的探测（每节点一次）和额度（每个 profile 一次） */
  async #probeAndQuota(agents: readonly AgentProfile[]): Promise<{
    probes: Map<string, NodeProbeResult>;
    quotas: Map<string, ProfileQuotaRead | null>;
  }> {
    const byNode = new Map<string, { baseUrl: string; token: string; profileId: string }>();
    for (const agent of agents) {
      const target = this.#quotaTargetOf(agent);
      if (target !== null && agent.nodeId !== null && !byNode.has(agent.nodeId)) byNode.set(agent.nodeId, target);
    }
    const probes = new Map<string, NodeProbeResult>();
    await Promise.all(
      [...byNode.entries()].map(async ([nodeId, target]) => {
        probes.set(
          nodeId,
          await this.#probe({ baseUrl: target.baseUrl, token: target.token, profileId: target.profileId }),
        );
      }),
    );
    // 节点都够不着就别再打额度端点（读不到就是未知，不是缺席）
    const reachable = agents.filter((agent) => {
      const probe = agent.nodeId === null ? undefined : probes.get(agent.nodeId);
      return probe !== undefined && probe.reachable && agent.profileId !== null && probe.profiles.includes(agent.profileId);
    });
    const quotas = await this.#quotaReadsFor(reachable);
    return { probes, quotas };
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
    case "chat_material_changed":
      return new DiscussionError("invalid_state", "材料里的聊天消息刚被撤回，请重新发起这一次");
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
