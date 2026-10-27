import { sha256Hex, type AgentAdapter } from "@room/core";
import {
  CHAT_LIMITS,
  ChatAgentOutput,
  chatSendIntentJson,
  extractMediaIntent,
  isExcludedFromContext,
  type AgentProfile,
  type ChatContent,
  type ChatContentInput,
  type ChatMessage,
  type ChatReplySlot,
  type ChatRun,
  type ChatSnapshot,
  type CommandRequest,
  type ControlErrorCode,
  type ControlEvent,
  type Conversation,
  type ConversationListItem,
  type BatchModel,
  type ChatAttachment,
  type ChatAttachmentInput,
  type Message,
  type NodeHealth,
  type Project,
  type NodeTestResult,
  type QueryRequest,
  type RunModel,
  type UserChatMessage,
} from "@room/schemas";
import {
  ChatSendConflictError,
  ChatSendDuplicateMessageError,
  ChatSendRateLimitError,
  ChatToTopicConflictError,
  chatRecipients,
  createChatSend,
  createChatToTopic,
  createConversation,
  finishChatRun,
  getChatMessage,
  getChatRun,
  getChatSlot,
  getChatSnapshot,
  getConversation,
  getFile,
  getImageRef,
  getSticker,
  insertChatRun,
  insertChatSnapshot,
  listChatMessages,
  listChatRunsForSlot,
  listChatSlotsForMessage,
  listChatSlotsForMessages,
  listConversations,
  markConversationRead,
  recordChatPromptFinal,
  repairInterruptedChatRuns,
  retractChatMessage,
  transitionChatRun,
  ulid,
  updateChatSlot,
  updateConversation,
  writeTransaction,
  type ChatRunTerminal,
  type ChatSendAvailability,
  type SqliteDatabase,
  type WriteQueue,
} from "@room/db";
import { testReviewerNode } from "@room/remote-client";
import {
  ChatModelUnavailableError,
  chatRunModel,
  reuseOrSelectChatModel,
  selectChatModel,
} from "./chat-model";
import { CHAT_MATERIAL_MAX_CHARS, CHAT_MATERIAL_PROMPT_HEADROOM, renderChatMaterial } from "./chat-material";
import { buildChatSnapshot, capChatFileTexts } from "./chat-prompt";
import type { Repository } from "./repository";
import type { SettingsStore } from "./settings";

/**
 * 聊天服务（D-31b 第四段）：把 chat.* 命令 / 查询接到数据库和节点上。
 *
 * 边界：
 * - 落库（消息 + 回答位 + Snapshot + Run）在 @room/db 的 createChatSend 里，一个事务
 * - 这里的职责是「防重复 → 限流 → 校验 → 探测 → 拼 Snapshot → 提交 → 启动 Run → 事件回落」
 * - Prompt 拼装是过渡实现（chat-prompt.ts），X-30 合并后替换
 * - 附件 / 语音 / 表情 / 转议题 / 历史摘要不在这一段
 */

export class ChatError extends Error {
  readonly code: ControlErrorCode;
  constructor(code: ControlErrorCode, message: string) {
    super(message);
    this.name = "ChatError";
    this.code = code;
  }
}

export interface ChatRunTarget {
  agent: string;
  nodeId: string;
  baseUrl: string;
  token: string;
  profileId: string;
  adapterId: string;
  /** C-40：这次定下的模型（{ model, effort }）；省略 = profile 自带 */
  model?: { model: string; effort: string | null };
}

export interface ChatServiceDeps {
  readonly db: SqliteDatabase;
  readonly queue: WriteQueue;
  readonly repo: Repository;
  readonly settings: SettingsStore;
  readonly emit: (event: ControlEvent) => void;
  /** 每次 Run 一个 adapter；测试注入假的 */
  readonly adapterFactory: (target: ChatRunTarget) => Promise<AgentAdapter>;
  /** 节点探测；默认真的打节点 */
  readonly probe?: (params: { baseUrl: string; token: string; profileId: string }) => Promise<NodeTestResult>;
  /** D-36b：把文件 ref 读成文本（非文本文件返回 null）；测试注入假的 */
  readonly readFileText?: (ref: string) => string | null;
  readonly now?: () => string;
  readonly idleTimeoutMs?: number;
  readonly totalTimeoutMs?: number;
}

const TERMINAL = new Set(["completed", "error", "cancelled", "timed_out"]);

export class ChatService {
  readonly #deps: ChatServiceDeps;
  readonly #active = new Map<string, AbortController>();

  constructor(deps: ChatServiceDeps) {
    this.#deps = deps;
  }

  #now(): string {
    return (this.#deps.now ?? (() => new Date().toISOString()))();
  }

  #emit(event: ControlEvent): void {
    this.#deps.emit(event);
  }

  /** 启动时修复：上次崩溃留下的聊天 Run 标成 FAILED(interrupted)，不留转圈 */
  async repairInterrupted(): Promise<number> {
    const result = await repairInterruptedChatRuns(this.#deps.db, this.#deps.queue);
    for (const runId of result.repaired) {
      const run = getChatRun(this.#deps.db, runId);
      if (run === null) continue;
      if (run.slotId !== null) {
        const slot = getChatSlot(this.#deps.db, run.slotId);
        if (slot !== null) this.#emit({ type: "chat.slot.updated", slot });
      }
      this.#emit({ type: "chat.run.updated", run });
    }
    return result.repaired.length;
  }

  activeCount(): number {
    return this.#active.size;
  }

  /** 退出前统一取消：让节点立刻停下 */
  cancelAll(): number {
    const count = this.#active.size;
    for (const controller of this.#active.values()) controller.abort();
    return count;
  }

  // ================================================================ 会话

  async createConversation(command: CommandRequest<"chat.conversation.create">): Promise<Conversation> {
    const conversation = await createConversation(this.#deps.db, this.#deps.queue, {
      members: command.members,
      title: command.title,
    });
    this.#emit({ type: "chat.conversation.updated", conversation });
    return conversation;
  }

  async updateConversation(command: CommandRequest<"chat.conversation.update">): Promise<Conversation> {
    const updated = await updateConversation(this.#deps.db, this.#deps.queue, command.conversationId, {
      ...(command.title === undefined ? {} : { title: command.title }),
      ...(command.pinned === undefined ? {} : { pinned: command.pinned }),
      ...(command.muted === undefined ? {} : { muted: command.muted }),
      ...(command.members === undefined ? {} : { members: command.members }),
    });
    if (updated === null) throw new ChatError("not_found", "会话不存在");
    this.#emit({ type: "chat.conversation.updated", conversation: updated });
    return updated;
  }

  async markRead(command: CommandRequest<"chat.conversation.markRead">): Promise<Conversation> {
    const conversation = await markConversationRead(
      this.#deps.db,
      this.#deps.queue,
      command.conversationId,
      command.messageId,
    );
    if (conversation === null) throw new ChatError("not_found", "会话或消息不存在");
    this.#emit({ type: "chat.conversation.updated", conversation });
    return conversation;
  }

  // ================================================================ 发送

  async send(
    command: CommandRequest<"chat.send">,
  ): Promise<{ message: UserChatMessage; slots: ChatReplySlot[]; runs: ChatRun[] }> {
    const { db, repo } = this.#deps;
    const now = this.#now();
    const intentHash = sha256Hex(chatSendIntentJson(command));

    // ① 防重复：同一个 id、意图相同 → 返回第一次的结果（不占限流名额）
    if (getChatMessage(db, command.messageId) !== null) return this.#replaySend(command.messageId, intentHash);

    const conversation = getConversation(db, command.conversationId);
    if (conversation === null) throw new ChatError("not_found", "会话不存在");

    // ② 限流
    const since = new Date(Date.parse(now) - 60_000).toISOString();
    const recent = db
      .prepare("SELECT count(*) AS n FROM chat_messages WHERE conversation_id = ? AND sender = 'user' AND created_at > ?")
      .get(command.conversationId, since) as { n: number };
    if (recent.n >= CHAT_LIMITS.messagesPerMinute) {
      throw new ChatError("rate_limited", "这个会话每分钟最多 " + CHAT_LIMITS.messagesPerMinute + " 条，稍等一下");
    }

    // ③ 校验
    if (conversation.kind === "direct" && command.mentions.kind !== "none") {
      throw new ChatError("validation_failed", "单聊不能 @ 人");
    }
    if (command.mentions.kind === "agents") {
      for (const agent of command.mentions.agents) {
        if (!conversation.members.includes(agent)) throw new ChatError("validation_failed", agent + " 不在这个会话里");
      }
    }
    const content = this.#resolveContent(command.content);

    if (command.quoteMessageId !== null) {
      const quote = getChatMessage(db, command.quoteMessageId);
      if (quote === null || quote.conversationId !== conversation.id) {
        throw new ChatError("validation_failed", "引用的消息不在这个会话里");
      }
      if (isExcludedFromContext(quote, this.#inReplyToOf)) {
        throw new ChatError("invalid_state", "引用的消息已经不在上下文里（撤回或回答已撤回）");
      }
    }
    if (command.replacesMessageId !== null) {
      const replaced = getChatMessage(db, command.replacesMessageId);
      if (replaced === null || replaced.sender !== "user" || replaced.conversationId !== conversation.id) {
        throw new ChatError("invalid_state", "只能重新编辑你自己的消息");
      }
      if (replaced.state !== "retracted") throw new ChatError("invalid_state", "只有已撤回的消息能重新编辑");
      // 契约：窗口从**撤回**算起（不是从发出算起），和 renderer 的 canReedit / mock 一致
      if (replaced.retractedAt === null) throw new ChatError("internal", "retracted message without retractedAt");
      if (Date.parse(now) - Date.parse(replaced.retractedAt) >= CHAT_LIMITS.reeditWindowMs) {
        throw new ChatError("invalid_state", "超过重新编辑的时间窗口");
      }
      if (db.prepare("SELECT 1 FROM chat_messages WHERE replaces_message_id = ?").get(replaced.id) !== undefined) {
        throw new ChatError("invalid_state", "这条消息已经重新编辑过了");
      }
    }

    const message: UserChatMessage = {
      id: command.messageId,
      conversationId: conversation.id,
      createdAt: now,
      sender: "user",
      content,
      mentions: command.mentions,
      quoteMessageId: command.quoteMessageId,
      replacesMessageId: command.replacesMessageId,
      state: "sent",
      retractedAt: null,
      ...(command.replyAsVoice === true ? { replyAsVoice: true as const } : {}),
    };

    // ④ 探测：每位收件人都要一句明确的「能不能答」
    const agents = new Map(repo.listAgents().map((agent) => [agent.id, agent]));
    const recipients = chatRecipients(conversation, command.mentions);
    const availability = new Map<string, ChatSendAvailability>();
    const probes = new Map<string, Promise<NodeTestResult>>();
    const probeResults = new Map<string, NodeTestResult>();
    for (const agentId of recipients) {
      availability.set(agentId, await this.#availabilityOf(agentId, agents, probes, probeResults));
    }

    // 模型：按 modelSettings 的「聊天」场合定下来；模型配置错了就当这个人缺席，不整条失败
    const models = new Map<string, BatchModel | null>();
    for (const agentId of recipients) {
      const agent = agents.get(agentId);
      if (agent === undefined) continue;
      if (availability.get(agentId)?.kind !== "available" || agent.chatProfileId === null) {
        models.set(agentId, null);
        continue;
      }
      try {
        models.set(
          agentId,
          selectChatModel(
            agent,
            agent.chatProfileId,
            profileModelsOf(probeResults.get(probeKeyOf(agent.nodeId, agent.chatProfileId))),
          ),
        );
      } catch (error) {
        if (!(error instanceof ChatModelUnavailableError)) throw error;
        availability.set(agentId, { kind: "unavailable", reason: "unconfigured" });
        models.set(agentId, null);
      }
    }

    // ⑤ 拼 Snapshot（只能答的人）
    const history = listChatMessages(db, conversation.id, null, 100).messages.slice().reverse();
    const promptFiles =
      content.kind === "text"
        ? capChatFileTexts(
            content.attachments
              .filter((attachment) => attachment.kind === "file")
              .map((attachment) => ({ name: attachment.name, text: this.#deps.readFileText?.(attachment.ref) ?? null })),
          )
        : [];
    const snapshots = new Map<string, ChatSnapshot>();
    const adapterIds = new Map<string, string>();
    for (const agentId of recipients) {
      if (availability.get(agentId)?.kind !== "available") continue;
      const agent = agents.get(agentId);
      if (agent === undefined || agent.chatProfileId === null) throw new ChatError("internal", "available agent is not configured: " + agentId);
      snapshots.set(
        agentId,
        buildChatSnapshot({
          snapshotId: "snap_" + ulid(),
          conversationId: conversation.id,
          userMessage: message,
          agent: { id: agent.id, displayName: agent.displayName, persona: this.#personaOf(agent) },
          history,
          quote: command.quoteMessageId === null ? null : getChatMessage(db, command.quoteMessageId),
          inReplyToOf: this.#inReplyToOf,
          displayNameOf: (id) => agents.get(id)?.displayName ?? id,
          ...(promptFiles.length === 0 ? {} : { files: promptFiles }),
          createdAt: now,
        }),
      );
      adapterIds.set(agentId, "remote:" + agent.chatProfileId);
    }

    // ⑥ 一个事务落库
    let result: Awaited<ReturnType<typeof createChatSend>>;
    try {
      result = await createChatSend(db, this.#deps.queue, {
        conversation,
        message,
        requestHash: intentHash,
        createdAt: now,
        availability,
        snapshots,
        adapterIds,
        models,
        rateLimit: { since, max: CHAT_LIMITS.messagesPerMinute },
      });
    } catch (error) {
      if (error instanceof ChatSendConflictError) throw new ChatError("invalid_state", error.message);
      // 并发：另一个同 id 请求先提交了 → 回滚后重新读，按防重复规则返回
      if (error instanceof ChatSendDuplicateMessageError) return this.#replaySend(command.messageId, intentHash);
      if (error instanceof ChatSendRateLimitError) {
        throw new ChatError("rate_limited", "这个会话每分钟最多 " + CHAT_LIMITS.messagesPerMinute + " 条，稍等一下");
      }
      throw error;
    }

    this.#emit({ type: "chat.message.created", message: result.message });
    for (const slot of result.slots) this.#emit({ type: "chat.slot.updated", slot });
    for (const run of result.runs) {
      this.#emit({ type: "chat.run.updated", run });
      this.#execute(run);
    }
    return result;
  }

  /** 一键转议题：选中的消息 → 新议题 + 一条 chat_material 材料，同一个事务 */
  async toTopic(
    command: CommandRequest<"chat.toTopic">,
  ): Promise<{ project: Project; material: Message }> {
    const { db } = this.#deps;
    const conversation = getConversation(db, command.conversationId);
    if (conversation === null) throw new ChatError("not_found", "会话不存在");
    if (new Set(command.messageIds).size !== command.messageIds.length) {
      throw new ChatError("validation_failed", "同一条消息不能选两次");
    }

    const messages = command.messageIds.map((messageId) => {
      const message = getChatMessage(db, messageId);
      if (message === null || message.conversationId !== conversation.id) {
        throw new ChatError("validation_failed", "选中的消息不在这个会话里：" + messageId);
      }
      return message;
    });

    // 已撤回的消息、以及回答已撤回消息的秘书发言，都不能选（和拼 Snapshot / 引用同一套规则）
    if (messages.some((message) => isExcludedFromContext(message, this.#inReplyToOf))) {
      throw new ChatError("invalid_state", "选中的消息里有已撤回的（或回答已撤回消息的发言），不能转议题");
    }

    const ordered = [...messages].sort((left, right) =>
      left.createdAt === right.createdAt ? (left.id < right.id ? -1 : 1) : left.createdAt < right.createdAt ? -1 : 1,
    );
    const agents = new Map(this.#deps.repo.listAgents().map((agent) => [agent.id, agent]));
    const content = renderChatMaterial(ordered, (agentId) => agents.get(agentId)?.displayName ?? agentId);
    if (content.length > CHAT_MATERIAL_MAX_CHARS - CHAT_MATERIAL_PROMPT_HEADROOM) {
      throw new ChatError(
        "validation_failed",
        "选中的消息太多，整理出来的材料太长（约 190 万字上限，要留出 Prompt 边界和任务的余量），少选几条",
      );
    }

    const now = this.#now();
    try {
      return await createChatToTopic(db, this.#deps.queue, {
        projectId: "proj_" + ulid(),
        materialId: "msg_" + ulid(),
        conversationId: conversation.id,
        name: command.name,
        chatMessageIds: ordered.map((message) => message.id),
        content,
        createdAt: now,
      });
    } catch (error) {
      if (error instanceof ChatToTopicConflictError) throw new ChatError("invalid_state", error.message);
      throw error;
    }
  }

  // ================================================================ 撤回 / 重试 / 取消

  async retract(
    command: CommandRequest<"chat.retract">,
  ): Promise<{ message: UserChatMessage; slots: ChatReplySlot[] }> {
    const { db, queue } = this.#deps;
    const message = getChatMessage(db, command.messageId);
    if (message === null || message.sender !== "user") throw new ChatError("not_found", "只能撤回你自己发的消息");
    if (message.state === "retracted") throw new ChatError("invalid_state", "这条消息已经撤回了");

    const now = this.#now();
    if (Date.parse(now) - Date.parse(message.createdAt) >= CHAT_LIMITS.retractWindowMs) {
      throw new ChatError("invalid_state", "超过撤回时间窗口");
    }

    const slots = listChatSlotsForMessage(db, message.id);
    const result = await writeTransaction(db, queue, () => {
      const updated = retractChatMessage(db, message.id, now);
      if (updated === null) throw new ChatError("invalid_state", "这条消息已经撤回了");
      const after: ChatReplySlot[] = [];
      for (const slot of slots) {
        if (slot.outcome === "retracted") {
          after.push(slot);
          continue;
        }
        const next: ChatReplySlot = { ...slot, outcome: "retracted", finishedAt: now };
        updateChatSlot(db, next);
        after.push(next);
      }
      return { message: updated, slots: after };
    });

    // 先落库再中止：迟到的结果会被 finishChatRun 丢掉（回答位已经不是 running）
    for (const slot of result.slots) {
      if (slot.runId === null) continue;
      const run = getChatRun(db, slot.runId);
      if (run !== null && (run.state === "QUEUED" || run.state === "STARTING" || run.state === "RUNNING")) {
        this.#active.get(run.id)?.abort();
      }
    }
    this.#emit({ type: "chat.message.updated", message: result.message });
    for (const slot of result.slots) this.#emit({ type: "chat.slot.updated", slot });
    return result;
  }

  async retry(command: CommandRequest<"chat.retry">): Promise<{ slot: ChatReplySlot; run: ChatRun }> {
    const { db, repo } = this.#deps;
    const slot = getChatSlot(db, command.slotId);
    if (slot === null) throw new ChatError("not_found", "回答位不存在");
    const message = getChatMessage(db, slot.userMessageId);
    if (message === null || message.sender !== "user") throw new ChatError("not_found", "回答位对应的消息不存在");
    if (message.state === "retracted") throw new ChatError("invalid_state", "消息已经撤回");
    if (!["failed", "absent_quota", "unavailable", "cancelled"].includes(slot.outcome)) {
      throw new ChatError("invalid_state", "这个回答位现在不能重试");
    }
    const conversation = getConversation(db, slot.conversationId);
    if (conversation === null) throw new ChatError("not_found", "会话不存在");
    if (!conversation.members.includes(slot.agent)) throw new ChatError("invalid_state", slot.agent + " 已经不在这个会话里");

    const agent = repo.getAgent(slot.agent);
    const probes = new Map<string, Promise<NodeTestResult>>();
    const probeResults = new Map<string, NodeTestResult>();
    const availability = await this.#availabilityOf(slot.agent, new Map([[agent.id, agent]]), probes, probeResults);
    if (availability.kind !== "available" || agent.chatProfileId === null) {
      throw new ChatError("agent_unavailable", slot.agent + " 现在还是不能答");
    }
    // 重试先沿用上一次的模型；节点已经不支持它再重选
    const previousModel = slot.runId === null ? null : (getChatRun(db, slot.runId)?.model ?? null);
    let model: BatchModel | null;
    try {
      model = reuseOrSelectChatModel(
        agent,
        agent.chatProfileId,
        profileModelsOf(probeResults.get(probeKeyOf(agent.nodeId, agent.chatProfileId))),
        previousModel,
      );
    } catch (error) {
      if (error instanceof ChatModelUnavailableError) throw new ChatError("agent_unavailable", error.message);
      throw error;
    }

    const now = this.#now();
    const agents = new Map(repo.listAgents().map((item) => [item.id, item]));
    // 重试的语境 = 原消息之前的历史：不能让它在回答 A 时看到后来才发的 B、C
    const history = listChatMessages(db, conversation.id, null, 100)
      .messages.slice()
      .reverse()
      .filter(
        (item) =>
          item.createdAt < message.createdAt || (item.createdAt === message.createdAt && item.id < message.id),
      );
    const runId = "run_" + ulid();
    const snapshot = buildChatSnapshot({
      snapshotId: "snap_" + ulid(),
      conversationId: conversation.id,
      userMessage: message,
      agent: { id: agent.id, displayName: agent.displayName, persona: this.#personaOf(agent) },
      history,
      quote: message.quoteMessageId === null ? null : getChatMessage(db, message.quoteMessageId),
      inReplyToOf: this.#inReplyToOf,
      displayNameOf: (id) => agents.get(id)?.displayName ?? id,
      createdAt: now,
    });

    const next = await writeTransaction(db, this.#deps.queue, () => {
      const running: ChatReplySlot = {
        ...slot,
        outcome: "running",
        runId,
        attempt: slot.attempt + 1,
        replyMessageId: null,
        failure: null,
        unavailableReason: null,
        finishedAt: null,
      };
      updateChatSlot(db, running);
      insertChatSnapshot(db, snapshot);
      const run: ChatRun = {
        id: runId,
        kind: "chat",
        purpose: "reply",
        conversationId: conversation.id,
        slotId: slot.id,
        agent: slot.agent,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.contentHash,
        finalPromptHash: null,
        memoryManifest: null,
        model,
        adapterId: "remote:" + agent.chatProfileId,
        state: "QUEUED",
        substate: null,
        failureReason: null,
        createdAt: now,
        startedAt: null,
        finishedAt: null,
      };
      insertChatRun(db, run);
      return { slot: running, run };
    });

    this.#emit({ type: "chat.slot.updated", slot: next.slot });
    this.#emit({ type: "chat.run.updated", run: next.run });
    this.#execute(next.run);
    return next;
  }

  async cancelReply(command: CommandRequest<"chat.cancelReply">): Promise<ChatReplySlot> {
    const { db, queue } = this.#deps;
    const slot = getChatSlot(db, command.slotId);
    if (slot === null) throw new ChatError("not_found", "回答位不存在");
    if (slot.outcome !== "running") throw new ChatError("invalid_state", "这个回答位没在回答");
    const next: ChatReplySlot = { ...slot, outcome: "cancelled", finishedAt: this.#now() };
    await writeTransaction(db, queue, () => updateChatSlot(db, next));
    if (slot.runId !== null) this.#active.get(slot.runId)?.abort();
    this.#emit({ type: "chat.slot.updated", slot: next });
    return next;
  }

  // ================================================================ 查询

  listConversations(): ConversationListItem[] {
    const { db } = this.#deps;
    return listConversations(db).map((conversation) => {
      const lastRow = db
        .prepare("SELECT id FROM chat_messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT 1")
        .get(conversation.id) as { id: string } | undefined;
      const lastMessage = lastRow === undefined ? null : getChatMessage(db, lastRow.id);
      let unreadCount = 0;
      // 未读只算秘书发来的：你自己发的消息不该顶出红点
      if (conversation.lastReadMessageId === null) {
        unreadCount = (
          db
            .prepare("SELECT count(*) AS n FROM chat_messages WHERE conversation_id = ? AND sender = 'agent'")
            .get(conversation.id) as { n: number }
        ).n;
      } else {
        const cursor = getChatMessage(db, conversation.lastReadMessageId);
        if (cursor !== null) {
          unreadCount = (
            db
              .prepare(
                "SELECT count(*) AS n FROM chat_messages WHERE conversation_id = ? AND sender = 'agent' " +
                  "AND (created_at > ? OR (created_at = ? AND id > ?))",
              )
              .get(conversation.id, cursor.createdAt, cursor.createdAt, cursor.id) as { n: number }
          ).n;
        }
      }
      const runningSlots = (
        db
          .prepare("SELECT count(*) AS n FROM chat_reply_slots WHERE conversation_id = ? AND outcome = 'running'")
          .get(conversation.id) as { n: number }
      ).n;
      return { conversation, lastMessage, unreadCount, runningSlots };
    });
  }

  getConversation(conversationId: string): Conversation {
    const conversation = getConversation(this.#deps.db, conversationId);
    if (conversation === null) throw new ChatError("not_found", "会话不存在");
    return conversation;
  }

  listMessages(command: QueryRequest<"chat.messages.list">): {
    messages: ChatMessage[];
    slots: ChatReplySlot[];
    nextCursor: { createdAt: string; id: string } | null;
  } {
    const page = listChatMessages(this.#deps.db, command.conversationId, command.before ?? null, command.limit ?? 50);
    const userMessageIds = page.messages.filter((message) => message.sender === "user").map((message) => message.id);
    return {
      messages: page.messages,
      slots: listChatSlotsForMessages(this.#deps.db, userMessageIds),
      nextCursor: page.nextCursor,
    };
  }

  listSlotRuns(slotId: string): ChatRun[] {
    if (getChatSlot(this.#deps.db, slotId) === null) throw new ChatError("not_found", "回答位不存在");
    return listChatRunsForSlot(this.#deps.db, slotId);
  }

  getRun(runId: string): ChatRun {
    const run = getChatRun(this.#deps.db, runId);
    if (run === null) throw new ChatError("not_found", "Run 不存在");
    return run;
  }

  getSnapshot(snapshotId: string): ChatSnapshot {
    const snapshot = getChatSnapshot(this.#deps.db, snapshotId);
    if (snapshot === null) throw new ChatError("not_found", "Snapshot 不存在");
    return snapshot;
  }

  // ================================================================ Run 执行

  #execute(run: ChatRun): void {
    void this.#run(run).catch((error: unknown) => {
      console.error("[chat] run failed:", error instanceof Error ? error.message : String(error));
    });
  }

  async #run(run: ChatRun): Promise<void> {
    const { db, queue, repo } = this.#deps;
    const controller = new AbortController();
    this.#active.set(run.id, controller);
    let current: ChatRun["state"] = run.state;

    const finish = async (terminal: ChatRunTerminal): Promise<void> => {
      const result = await finishChatRun(db, queue, { runId: run.id, from: current, terminal });
      if (result.message !== null) this.#emit({ type: "chat.message.created", message: result.message });
      if (result.slot !== null) this.#emit({ type: "chat.slot.updated", slot: result.slot });
      this.#emit({ type: "chat.run.updated", run: result.run });
    };

    try {
      const agent = repo.getAgent(run.agent);
      const target = this.#targetOf(agent, run);
      current = (
        await writeTransaction(db, queue, () => transitionChatRun(db, run.id, current, "STARTING", { startedAt: this.#now() }))
      ).state;
      this.#emit({ type: "chat.run.updated", run: getChatRun(db, run.id) as ChatRun });

      const adapter = await this.#deps.adapterFactory(target);
      await adapter.initialize();
      const session = await adapter.startSession({ projectId: "chat:" + run.conversationId });
      current = (
        await writeTransaction(db, queue, () => transitionChatRun(db, run.id, current, "RUNNING", { substate: "active" }))
      ).state;
      this.#emit({ type: "chat.run.updated", run: getChatRun(db, run.id) as ChatRun });

      const snapshot = getChatSnapshot(db, run.snapshotId);
      if (snapshot === null) throw new Error("chat snapshot missing: " + run.snapshotId);

      let completedText: string | null = null;
      const events = adapter.run(
        session.sessionId,
        run.id,
        {
          snapshotId: snapshot.id,
          content: snapshot.content,
          contentHash: snapshot.contentHash,
          chat: { memory: snapshot.memorySlot },
        },
        {
          signal: controller.signal,
          onPermissionRequest: async () => ({ decision: "deny", decidedBy: "system" }),
          idleTimeoutMs: this.#deps.idleTimeoutMs ?? 120_000,
          totalTimeoutMs: this.#deps.totalTimeoutMs ?? 600_000,
        },
      );

      for await (const event of events) {
        if (event.type === "message_complete") completedText = event.text;
        if (event.type === "prompt_final") {
          await writeTransaction(db, queue, () =>
            recordChatPromptFinal(db, run.id, event.finalPromptHash, event.memory),
          );
          const updated = getChatRun(db, run.id);
          if (updated !== null) this.#emit({ type: "chat.run.updated", run: updated });
          continue;
        }
        if (TERMINAL.has(event.type)) {
          if (event.type === "completed") {
            // 契约：整段输出是一个 JSON 对象（首尾空白可以有），不是 JSON 字符串
            const blank = (completedText ?? "").trim().length === 0;
            let output: unknown;
            let parseFailed = false;
            try {
              output = JSON.parse(completedText ?? "");
            } catch {
              parseFailed = true;
            }
            const parsed = parseFailed ? null : ChatAgentOutput.safeParse(output);
            // reply 的 text 去空白后为空也算交了白卷（schema 会拒绝它，但这是 empty_output 不是格式坏）
            const blankReply =
              typeof output === "object" &&
              output !== null &&
              (output as { kind?: unknown }).kind === "reply" &&
              typeof (output as { text?: unknown }).text === "string" &&
              ((output as { text: string }).text.trim().length === 0);
            if (parsed === null || !parsed.success) {
              await finish({
                kind: "failed",
                failure: { kind: blank || blankReply ? "empty_output" : "parse_error", message: "输出不是合法的聊天 JSON" },
              });
            } else if (parsed.data.kind === "skip") {
              await finish({ kind: "skipped" });
            } else {
              // C-42e / D-31d：合格的媒体意图和回答一起落库；不合格的那几项只进审计日志（ADR-004 §3a，
              // 「结构合法但媒体字段超限，只丢掉媒体意图、照常显示文字，并记下原始意图」）。
              // 原始值可能很长（比如超长的 draw 提示词），日志截断到 2000 字，别让一条回答把日志撑爆
              const media = extractMediaIntent(parsed.data);
              if (media.dropped) {
                console.warn(
                  "[chat] dropped an invalid media intent",
                  JSON.stringify({ runId: run.id, agent: run.agent, speak: parsed.data.speak, draw: parsed.data.draw }).slice(0, 2000),
                );
              }
              await finish({
                kind: "answered",
                text: parsed.data.text,
                ...(media.intent === null ? {} : { mediaIntent: media.intent }),
              });
            }
          } else if (event.type === "error") {
            if (event.reason === "quota_exhausted") await finish({ kind: "absent_quota" });
            else {
              await finish({
                kind: "failed",
                failure: { kind: "run_failed", message: event.message ?? event.reason },
                failureReason: event.reason,
              });
            }
          } else if (event.type === "timed_out") {
            await finish({ kind: "timed_out" });
          } else {
            await finish({ kind: "cancelled" });
          }
          return;
        }
        this.#emit({ type: "run.event", event });
      }

      await finish({
        kind: "failed",
        failure: { kind: "run_failed", message: "adapter ended without a terminal event" },
        failureReason: "internal",
      });
    } catch (error) {
      if (current === "QUEUED" || current === "STARTING" || current === "RUNNING") {
        try {
          await finish({
            kind: "failed",
            failure: { kind: "run_failed", message: error instanceof Error ? error.message : String(error) },
            failureReason: "internal",
          });
        } catch {
          // 别的路径已经收尾了（撤回 / 取消 / 中断修复）：丢弃
        }
      }
    } finally {
      this.#active.delete(run.id);
    }
  }

  // ================================================================ 内部

  /** 防重复的统一出口：意图相同返回第一次的结果，不同就报冲突 */
  #replaySend(messageId: string, intentHash: string): { message: UserChatMessage; slots: ChatReplySlot[]; runs: ChatRun[] } {
    const message = getChatMessage(this.#deps.db, messageId);
    if (message === null || message.sender !== "user") throw new ChatError("internal", "chat message disappeared");
    const stored = this.#deps.db.prepare("SELECT request_hash FROM chat_messages WHERE id = ?").get(messageId) as
      | { request_hash: string | null }
      | undefined;
    if (stored?.request_hash !== intentHash) throw new ChatError("idempotency_conflict", "同一个 messageId 发了不一样的内容");
    return this.#sendResult(message);
  }

  #sendResult(message: UserChatMessage): { message: UserChatMessage; slots: ChatReplySlot[]; runs: ChatRun[] } {
    const slots = listChatSlotsForMessage(this.#deps.db, message.id);
    return { message, slots, runs: slots.flatMap((slot) => listChatRunsForSlot(this.#deps.db, slot.id)) };
  }

  #inReplyToOf = (messageId: string): UserChatMessage | undefined => {
    const message = getChatMessage(this.#deps.db, messageId);
    return message !== null && message.sender === "user" ? message : undefined;
  };

  #personaOf(agent: AgentProfile): string {
    return agent.chatPersona.trim().length > 0 ? agent.chatPersona : agent.roleNote;
  }

  /**
   * ChatContentInput → ChatContent。
   * - 文件（D-36b）：校验引用后带进消息；能当文本读的正文会进 Prompt 的资料区
   * - 图片：引用校验先做，但**节点还不能收图**（S-23 还没合），现在明确拒绝，不悄悄降级
   * - 语音：等 D-34b
   */
  #resolveContent(input: ChatContentInput): ChatContent {
    if (input.kind === "text") {
      const attachments = input.attachments.map((attachment) => this.#resolveAttachment(attachment));
      return { kind: "text", text: input.text, attachments };
    }
    if (input.kind === "sticker") {
      // C-34：发送时只传 stickerId，image 和 label 从表情库抄一份记在消息上
      const sticker = getSticker(this.#deps.db, input.stickerId);
      if (sticker === null) throw new ChatError("validation_failed", "这个表情已经不在表情库里了");
      return { kind: "sticker", stickerId: sticker.id, image: sticker.image, label: sticker.label };
    }
    throw new ChatError("validation_failed", "语音还没上线（D-34b），先发文字或语音转写成文字");
  }

  /** 校验一个附件引用，返回记进消息的那份（文件字段从库里抄，renderer 只拿 ref） */
  #resolveAttachment(attachment: ChatAttachmentInput): ChatAttachment {
    if (attachment.kind === "image") {
      const image = getImageRef(this.#deps.db, attachment.ref);
      if (image === null || image.purpose !== "chat") {
        throw new ChatError("validation_failed", "图片引用不存在（或者不是聊天图片），请重新选一张");
      }
      // 节点收图（S-23）还没合：现在带图发不出去，明确拒绝
      throw new ChatError("validation_failed", "节点还不能收图（S-23 还没合），先把图片去掉");
    }
    const file = getFile(this.#deps.db, attachment.ref);
    if (file === null) throw new ChatError("validation_failed", "文件引用不存在，请重新选一个");
    return {
      kind: "file",
      ref: file.ref,
      name: file.name,
      mime: file.mime,
      bytes: file.bytes,
      sha256: file.sha256,
      isText: file.isText,
    };
  }

  async #availabilityOf(
    agentId: string,
    agents: Map<string, AgentProfile>,
    probes: Map<string, Promise<NodeTestResult>>,
    results?: Map<string, NodeTestResult>,
  ): Promise<ChatSendAvailability> {
    const agent = agents.get(agentId) ?? this.#deps.repo.getAgent(agentId);
    if (agent.pausedByUser) return { kind: "unavailable", reason: "paused_by_user" };
    if (agent.nodeId === null || agent.chatProfileId === null) return { kind: "unavailable", reason: "unconfigured" };
    const node = this.#deps.repo.getNodeRow(agent.nodeId);
    const credential = this.#deps.settings.getNode(agent.nodeId);
    if (node === undefined || node.base_url === null || credential === null || credential.baseUrl !== node.base_url) {
      return { kind: "unavailable", reason: "unconfigured" };
    }

    // 同一个节点上的不同 profile 是两次独立的探测：profileAvailable 是 per-profile 的
    const probeKey = probeKeyOf(agent.nodeId, agent.chatProfileId);
    let probe = probes.get(probeKey);
    if (probe === undefined) {
      probe = (this.#deps.probe ?? testReviewerNode)({
        baseUrl: credential.baseUrl,
        token: credential.token,
        profileId: agent.chatProfileId,
      });
      probes.set(probeKey, probe);
    }
    const result = await probe;
    results?.set(probeKey, result);
    if (!result.reachable) return { kind: "unavailable", reason: "offline" };
    return result.profileAvailable ? { kind: "available" } : { kind: "unavailable", reason: "offline" };
  }

  #targetOf(agent: AgentProfile, run: ChatRun): ChatRunTarget {
    if (agent.nodeId === null || agent.chatProfileId === null) {
      throw new ChatError("agent_unavailable", agent.id + " 没有配置聊天节点 / profile");
    }
    const node = this.#deps.repo.getNodeRow(agent.nodeId);
    if (node === undefined || node.base_url === null) {
      throw new ChatError("agent_unavailable", "节点 " + agent.nodeId + " 没有配置地址");
    }
    const credential = this.#deps.settings.getNode(agent.nodeId);
    if (credential === null) throw new ChatError("agent_unavailable", "节点 " + agent.nodeId + " 没有配置 Token");
    return {
      agent: agent.id,
      nodeId: agent.nodeId,
      baseUrl: credential.baseUrl,
      token: credential.token,
      profileId: agent.chatProfileId,
      adapterId: "remote:" + agent.chatProfileId,
      ...(chatRunModel(run.model) === undefined ? {} : { model: chatRunModel(run.model) as RunModel }),
    };
  }
}

/** 节点上报的 profileModels；够不着节点 / 老节点时为 undefined */
function profileModelsOf(result: NodeTestResult | undefined): NodeHealth["profileModels"] | undefined {
  return result !== undefined && result.reachable ? result.health.profileModels : undefined;
}

/** 探测缓存的 key：同一个节点上的不同 profile 是两次独立的探测 */
function probeKeyOf(nodeId: string | null, profileId: string | null): string {
  return (nodeId ?? "") + "\u0000" + (profileId ?? "");
}



