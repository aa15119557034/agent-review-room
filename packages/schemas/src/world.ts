import { z } from "zod";
import { IsoTimestamp, prefixedId } from "./common";
import { AgentName } from "./entities";

/**
 * 世界第一版：秘书们的共享小屋（ADR-008 / C-53）。
 *
 * 几条贯穿全文件的规矩（都来自 ADR-008）：
 * - 世界的事实只由规则层（main）写。模型只「提议」和写台词；renderer 只发命令。
 * - 居民的动作、你的操作、作息规则产生的动作，走同一套检查（WorldRejectReason）。
 * - 每个请求带「代次」。重置、从备份恢复、切换资料都换一代（epoch）；暂停再继续记一次（runSeq）。
 *   回来时代次对不上的结果直接作废，不看它现在是否碰巧还合条件。
 * - 给居民的东西只来自她自己的观察。本文件里带「全貌」的类型（WorldSnapshot、WorldEvent 列表）
 *   只给界面用，main 不得把它们放进任何居民的认知上下文。
 * - 模型回的内容是受限的显示数据（WorldCognitionReply），不是脚本，程序不执行其中任何东西。
 *
 * 本文件只定格式和语义，不含规则数值（体力怎么掉、做饭多久），那些在规则层，随 rulesVersion 走。
 */

// ================================================================ id 和小类型

export const WorldId = prefixedId("world");
export type WorldId = z.infer<typeof WorldId>;
/** 动作 id：谁发起谁生成（你的操作由 renderer 生成）。同一个 id 再来一次不重复生效，返回第一次的结果 */
export const WorldActionId = prefixedId("wact");
export type WorldActionId = z.infer<typeof WorldActionId>;
export const WorldActivityId = prefixedId("wavt");
export type WorldActivityId = z.infer<typeof WorldActivityId>;
export const WorldCommitmentId = prefixedId("wcom");
export type WorldCommitmentId = z.infer<typeof WorldCommitmentId>;
export const WorldSceneId = prefixedId("wscn");
export type WorldSceneId = z.infer<typeof WorldSceneId>;

/** 地点、物品的 id 是内容里写死的短名（living_room、book），不是 ULID：规则和素材都按它找 */
const slug = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/);
export const WorldPlaceId = slug;
export type WorldPlaceId = z.infer<typeof WorldPlaceId>;
export const WorldItemId = slug;
export type WorldItemId = z.infer<typeof WorldItemId>;

/** 世界里的时间：从第 1 天 00:00 起的分钟数。第几天、几点几分都由它算，不另存 */
export const WorldMinutes = z.number().int().nonnegative();
export const WORLD_MINUTES_PER_DAY = 1440;
/** 事件序号：每个世界每一代从 1 递增，只追加 */
export const WorldSeq = z.number().int().positive();
/** 0–100 的状态数（体力、饱腹、心情） */
const Gauge = z.number().int().min(0).max(100);

/** 代次。epoch：重置 / 恢复 / 切换资料时加一；runSeq：每次暂停再继续加一 */
export const WorldGeneration = z.object({ epoch: z.number().int().positive(), runSeq: z.number().int().nonnegative() }).strict();
export type WorldGeneration = z.infer<typeof WorldGeneration>;

/** 世界里的「谁」：一位居民，或者你 */
export const WorldActor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resident"), agent: AgentName }).strict(),
  z.object({ kind: z.literal("player") }).strict(),
]);
export type WorldActor = z.infer<typeof WorldActor>;

// ================================================================ 世界里的东西

export const WorldPlace = z.object({
  id: WorldPlaceId,
  label: z.string().min(1).max(40),
  /** 和哪些地点相连。没有坐标 */
  neighbors: z.array(WorldPlaceId).max(8),
  /** 是某位居民自己的房间时写她；公共区域是 null */
  owner: AgentName.nullable(),
}).strict();
export type WorldPlace = z.infer<typeof WorldPlace>;

/** 第一版的活动种类。加新的要改契约 */
export const WorldActivityKind = z.enum(["cook", "eat", "read", "rest", "sleep", "tidy", "set_table"]);
export type WorldActivityKind = z.infer<typeof WorldActivityKind>;

export const WorldActivityState = z.enum(["running", "completed", "cancelled", "failed"]);
export const WorldActivity = z.object({
  id: WorldActivityId,
  kind: WorldActivityKind,
  /** 一起做的人，至少一位；可以包含你 */
  participants: z.array(WorldActor).min(1).max(8),
  placeId: WorldPlaceId,
  /** 占着的唯一物品（锅、书、座位） */
  itemIds: z.array(WorldItemId).max(8),
  startedAt: WorldMinutes,
  /** 预计结束。到点由规则结算一次 */
  endsAt: WorldMinutes,
  state: WorldActivityState,
  /** state 不是 running 时写为什么结束；running 时是 null */
  endReason: z.enum(["done", "cancelled_by_actor", "cancelled_by_player", "interrupted", "missing_resource", "world_reset"]).nullable(),
}).strict().refine((a) => (a.state === "running") === (a.endReason === null), { message: "endReason 只在结束后有" });
export type WorldActivity = z.infer<typeof WorldActivity>;

/**
 * 居民现在靠什么行动。model：正常；routine：按作息和简单规则（节点不在线、今天次数用完、她正在聊天或讨论室里忙）。
 * 界面据此写明「她现在不在线」「今天的思考次数用完了」
 */
export const WorldCognitionMode = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("model") }).strict(),
  z.object({ mode: z.literal("routine"), reason: z.enum(["offline", "budget", "busy_elsewhere"]) }).strict(),
]);
export type WorldCognitionMode = z.infer<typeof WorldCognitionMode>;

export const WorldResident = z.object({
  agent: AgentName,
  placeId: WorldPlaceId,
  energy: Gauge,
  satiety: Gauge,
  mood: Gauge,
  /** 最多一个主要活动 */
  activityId: WorldActivityId.nullable(),
  cognition: WorldCognitionMode,
}).strict();
export type WorldResident = z.infer<typeof WorldResident>;

/** 物品在哪：某个地点，或某个人手里。二选一 */
export const WorldItemLocation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("place"), placeId: WorldPlaceId }).strict(),
  z.object({ kind: z.literal("held"), by: WorldActor }).strict(),
]);
export type WorldItemLocation = z.infer<typeof WorldItemLocation>;

export const WorldItem = z.discriminatedUnion("kind", [
  /** 唯一的东西（一本书、一口锅、一个座位）。usedBy：正被哪个活动占着 */
  z.object({
    kind: z.literal("unique"), id: WorldItemId, label: z.string().min(1).max(40),
    at: WorldItemLocation, usedBy: WorldActivityId.nullable(),
  }).strict(),
  /** 记数量的东西（食材、做好的饭）。只放在地点上 */
  z.object({
    kind: z.literal("stock"), id: WorldItemId, label: z.string().min(1).max(40),
    placeId: WorldPlaceId, count: z.number().int().nonnegative().max(999),
  }).strict(),
]);
export type WorldItem = z.infer<typeof WorldItem>;

/**
 * 约定：谁答应了谁什么。只是一个小记录，不是通用任务调度。
 * pending：答应了还没做；deferred：说了「晚点」，dueAt 是说好的时间；done / cancelled / expired 是终态
 */
export const WorldCommitmentState = z.enum(["pending", "deferred", "done", "cancelled", "expired"]);
export const WorldCommitment = z.object({
  id: WorldCommitmentId,
  /** 答应的人 */
  by: WorldActor,
  /** 答应了谁 */
  to: WorldActor,
  activity: WorldActivityKind,
  dueAt: WorldMinutes.nullable(),
  state: WorldCommitmentState,
  /** 开始履行后对应的活动 */
  activityId: WorldActivityId.nullable(),
  createdAt: WorldMinutes,
}).strict();
export type WorldCommitment = z.infer<typeof WorldCommitment>;

// ================================================================ 动作和拒绝原因

/** 规则层拒绝一个动作的原因。界面和台词里的「为什么做不了」都从这里来，不让模型自己编 */
export const WorldRejectReason = z.enum([
  "stale_generation",   // 代次对不上（重置、恢复、暂停过）
  "world_paused",
  "unknown_target",     // 没有这个地点 / 物品 / 人 / 场景
  "not_adjacent",       // 要去的地点不相连
  "not_same_place",     // 不在同一间屋
  "actor_busy",         // 她或你正在做别的
  "item_busy",          // 东西被占着
  "item_not_here",      // 东西不在这里 / 不在手里
  "out_of_stock",       // 数量不够（食材、饭）
  "not_allowed",        // 这个活动不能在这里做，或这样东西不能这样用
  "scene_closed",
  "option_expired",     // 情况已经变了，这个选项失效
  "duplicate_action",   // 同一个 actionId 发了不一样的内容
]);
export type WorldRejectReason = z.infer<typeof WorldRejectReason>;

/**
 * 一个动作的内容。居民的模型提议、作息规则、你的操作都用这一套。
 * 模型只能从这里面选；它没法发明新动作。
 */
const MoveAction = z.object({ type: z.literal("move"), to: WorldPlaceId }).strict();
const TakeAction = z.object({ type: z.literal("take"), itemId: WorldItemId }).strict();
const PutAction = z.object({ type: z.literal("put"), itemId: WorldItemId }).strict();
/** 开始一个活动。itemId：要用的那样唯一物品（看哪本书）；不需要时是 null */
const StartAction = z.object({ type: z.literal("start"), activity: WorldActivityKind, itemId: WorldItemId.nullable() }).strict();
/** 停下自己正在做的 */
const StopAction = z.object({ type: z.literal("stop") }).strict();
/** 邀请同屋的某个人做某件事（或一起做） */
const InviteAction = z.object({ type: z.literal("invite"), to: WorldActor, activity: WorldActivityKind }).strict();
/** 回应一个邀请。later：晚点，dueAt 是说好的时间；只有 later 带 dueAt */
const AnswerAction = z.object({
  type: z.literal("answer"), commitmentId: WorldCommitmentId,
  answer: z.enum(["accept", "later", "decline"]), dueAt: WorldMinutes.nullable(),
}).strict();
/** 加入别人已经开始的活动 */
const JoinAction = z.object({ type: z.literal("join"), activityId: WorldActivityId }).strict();

export const WorldAction = z
  .discriminatedUnion("type", [MoveAction, TakeAction, PutAction, StartAction, StopAction, InviteAction, AnswerAction, JoinAction])
  .refine((a) => a.type !== "answer" || (a.answer === "later") === (a.dueAt !== null), { message: "只有 later 带 dueAt" });
export type WorldAction = z.infer<typeof WorldAction>;

/** 动作提交后的结果。accepted=false 时什么都没改 */
export const WorldActionResult = z.discriminatedUnion("accepted", [
  z.object({ accepted: z.literal(true), seq: WorldSeq }).strict(),
  z.object({ accepted: z.literal(false), reason: WorldRejectReason }).strict(),
]);
export type WorldActionResult = z.infer<typeof WorldActionResult>;

// ================================================================ 事件和观察

/**
 * 已提交的事件。只追加，不改。这是「真的发生了什么」的唯一来源：
 * 状态数、熟悉度、约定、物品数量都必须能从事件重新算出来。
 *
 * - action：一个动作被接受并生效（拒绝的动作不进事件，只回给发起者）
 * - activity_ended：活动结算（produced：产出了什么，比如几份饭）
 * - said：有人在某个地点说了一句话。text 是台词原文，**不是事实**：别人听到只算「听说」
 * - clock：到了作息点 / 新的一天，供回顾和界面用
 */
export const WorldEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("action"), seq: WorldSeq, at: WorldMinutes, placeId: WorldPlaceId,
    actor: WorldActor, action: WorldAction, activityId: WorldActivityId.nullable(), commitmentId: WorldCommitmentId.nullable(),
  }).strict(),
  z.object({
    type: z.literal("activity_ended"), seq: WorldSeq, at: WorldMinutes, placeId: WorldPlaceId,
    activity: WorldActivity,
    produced: z.array(z.object({ itemId: WorldItemId, count: z.number().int().positive().max(99) }).strict()).max(8),
    consumed: z.array(z.object({ itemId: WorldItemId, count: z.number().int().positive().max(99) }).strict()).max(8),
  }).strict(),
  z.object({
    type: z.literal("said"), seq: WorldSeq, at: WorldMinutes, placeId: WorldPlaceId,
    speaker: WorldActor, text: z.string().min(1).max(500), sceneId: WorldSceneId.nullable(),
  }).strict(),
  z.object({
    type: z.literal("clock"), seq: WorldSeq, at: WorldMinutes,
    mark: z.enum(["day_started", "day_ended"]), day: z.number().int().positive(),
  }).strict(),
]);
export type WorldEvent = z.infer<typeof WorldEvent>;

/**
 * 一位居民对一条事件的观察。saw：在场看到；heard：在场听到别人说的话；told：别人后来告诉她的（via 是那句话的事件）。
 * 她的认知上下文、回忆、回顾里属于她的部分，只从这里取。
 */
export const WorldObservation = z.object({
  observer: AgentName,
  seq: WorldSeq,
  at: WorldMinutes,
  mode: z.enum(["saw", "heard", "told"]),
  /** mode = told 时是告诉她的那句话的事件序号；否则 null */
  via: WorldSeq.nullable(),
}).strict().refine((o) => (o.mode === "told") === (o.via !== null), { message: "via 只在 told 时有" });
export type WorldObservation = z.infer<typeof WorldObservation>;

// ================================================================ 剧情和对话场景

export const WorldExpression = z.enum(["neutral", "happy", "sad", "tired", "surprised", "annoyed", "shy"]);
export type WorldExpression = z.infer<typeof WorldExpression>;

/** 自己冒出来的剧情的固定几种起因（ADR-008 §2） */
export const WorldSceneCause = z.enum([
  "item_contention",   // 两人争同一样东西
  "cook_result",       // 做饭成功或失败
  "low_state",         // 有人太累、太饿、心情太低
  "first_together",    // 两人第一次一起做某件事
  "day_review",        // 一天结束的回顾
]);
export type WorldSceneCause = z.infer<typeof WorldSceneCause>;

/**
 * 一句显示出来的台词。source = model：模型写的、已按 ADR-008 §2 核对过；rule：规则旁白（模型不在、或台词对不上被换掉）。
 * speaker 是 null 表示旁白。
 */
export const WorldSceneLine = z.object({
  speaker: WorldActor.nullable(),
  text: z.string().min(1).max(500),
  expression: WorldExpression,
  source: z.enum(["model", "rule"]),
}).strict();
export type WorldSceneLine = z.infer<typeof WorldSceneLine>;

/** 选项由规则给出，每个对应一个规则认可的动作。模型不能加选项，也看不到 action 以外的东西 */
export const WorldSceneOption = z.object({
  id: z.string().regex(/^opt_[a-z0-9_]{1,30}$/),
  label: z.string().min(1).max(60),
  /** 选了以后以谁的名义做。不管（让她们自己商量）是 null */
  act: z.object({ actor: WorldActor, action: WorldAction }).strict().nullable(),
}).strict();
export type WorldSceneOption = z.infer<typeof WorldSceneOption>;

export const WorldScene = z.object({
  id: WorldSceneId,
  /** 开场时的代次。代次变了场景就关 */
  generation: WorldGeneration,
  origin: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("event"), cause: WorldSceneCause, seq: WorldSeq }).strict(),
    /** 你走过去找她说话 */
    z.object({ kind: z.literal("player"), agent: AgentName }).strict(),
  ]),
  placeId: WorldPlaceId,
  /** 在场的居民（立绘按这个画） */
  residents: z.array(AgentName).min(1).max(4),
  lines: z.array(WorldSceneLine).max(200),
  /** 现在能选的。空数组 = 没有选项 */
  options: z.array(WorldSceneOption).max(4),
  /** 能不能打一句话。她的节点不在时是 false，界面明说她现在没法回应 */
  canType: z.boolean(),
  /** waiting：在等她回话；open：等你；closed：结束，只能回看 */
  state: z.enum(["open", "waiting", "closed"]),
  openedAt: WorldMinutes,
  createdAt: IsoTimestamp,
}).strict();
export type WorldScene = z.infer<typeof WorldScene>;

/** 一天的回顾。每一条都指回事件；text 的措辞可以由模型润色，内容不能超出那些事件 */
export const WorldDayReview = z.object({
  day: z.number().int().positive(),
  items: z.array(z.object({
    seqs: z.array(WorldSeq).min(1).max(20),
    text: z.string().min(1).max(300),
    source: z.enum(["model", "rule"]),
  }).strict()).max(40),
}).strict();
export type WorldDayReview = z.infer<typeof WorldDayReview>;

// ================================================================ 界面看到的整份状态

export const WorldRunState = z.discriminatedUnion("state", [
  z.object({ state: z.literal("running") }).strict(),
  /** by = user：你按的；maintenance：备份等维护自动暂停的，结束后只有这种会自动恢复 */
  z.object({ state: z.literal("paused"), by: z.enum(["user", "maintenance"]) }).strict(),
]);
export type WorldRunState = z.infer<typeof WorldRunState>;

/**
 * 界面用的全貌。**只给界面**，不进任何居民的上下文。
 * 时间：now 是这份快照提交时的世界时间，asOf 是对应的现实时刻，minutesPerRealSecond 是当前流速（暂停时是 0）；
 * 界面据此自己插值显示时钟，不用每个 tick 推一次。
 */
export const WorldSnapshot = z.object({
  id: WorldId,
  generation: WorldGeneration,
  rulesVersion: z.string().min(1).max(40),
  run: WorldRunState,
  now: WorldMinutes,
  asOf: IsoTimestamp,
  minutesPerRealSecond: z.number().nonnegative().max(600),
  /** 最后一条事件的序号；还没有事件是 0 */
  lastSeq: z.number().int().nonnegative(),
  places: z.array(WorldPlace).min(1).max(12),
  residents: z.array(WorldResident).min(1).max(8),
  /** 你在哪间屋 */
  player: z.object({ placeId: WorldPlaceId, activityId: WorldActivityId.nullable() }).strict(),
  items: z.array(WorldItem).max(60),
  /** 正在进行的活动 */
  activities: z.array(WorldActivity).max(20),
  /** 还没到终态的约定 */
  commitments: z.array(WorldCommitment).max(40),
  /** 现在开着的场景；没有是 null。同一时间最多一个 */
  sceneId: WorldSceneId.nullable(),
}).strict().superRefine((w, ctx) => {
  const places = new Set(w.places.map((p) => p.id));
  if (places.size !== w.places.length) ctx.addIssue({ code: "custom", message: "地点 id 重复" });
  if (new Set(w.residents.map((r) => r.agent)).size !== w.residents.length) ctx.addIssue({ code: "custom", message: "居民重复" });
  if (new Set(w.items.map((i) => i.id)).size !== w.items.length) ctx.addIssue({ code: "custom", message: "物品 id 重复" });
  for (const r of w.residents) if (!places.has(r.placeId)) ctx.addIssue({ code: "custom", message: "居民在不存在的地点" });
  if (!places.has(w.player.placeId)) ctx.addIssue({ code: "custom", message: "你在不存在的地点" });
});
export type WorldSnapshot = z.infer<typeof WorldSnapshot>;

/**
 * 「她知道什么」：切到某位居民的视角时界面看到的。只含她自己的观察能支持的东西。
 * knownItems：她印象里每样东西在哪、是什么时候、怎么知道的。可能是旧的，和真实状态不一致是正常的。
 */
export const WorldResidentView = z.object({
  agent: AgentName,
  generation: WorldGeneration,
  knownItems: z.array(z.object({
    itemId: WorldItemId,
    at: WorldItemLocation.nullable(),
    count: z.number().int().nonnegative().max(999).nullable(),
    asOf: WorldMinutes,
    mode: WorldObservation.innerType().shape.mode,
  }).strict()).max(60),
  /** 她最近的观察，新的在前 */
  recent: z.array(z.object({ observation: WorldObservation, event: WorldEvent }).strict()).max(100),
}).strict();
export type WorldResidentView = z.infer<typeof WorldResidentView>;

// ================================================================ 设置和用量

/** 世界里一天默认对应现实里 24 分钟（世界一小时 = 现实一分钟）。可调 */
export const WORLD_DAY_REAL_MINUTES_DEFAULT = 24;
/** 每位居民每个现实日的认知次数默认上限 */
export const WORLD_DAILY_COGNITION_DEFAULT = 60;
/** 一段场景里模型台词的轮数上限 */
export const WORLD_SCENE_MAX_MODEL_TURNS = 8;

export const WorldSettings = z.object({
  /** 世界里一天 = 现实里几分钟 */
  dayRealMinutes: z.number().int().min(4).max(1440),
  /** 每位居民每个**现实日**最多几次认知。0 = 不调模型，全按作息 */
  dailyCognitionLimit: z.number().int().min(0).max(1000),
  /** 住进来的居民。改它等于重开一局，只能随 world.reset 改 */
  residents: z.array(AgentName).min(1).max(8),
}).strict();
export type WorldSettings = z.infer<typeof WorldSettings>;

/**
 * 认知次数的用量。按现实日算，**记在世界存档之外**：快进、重置、恢复旧备份都不会把 used 减回去。
 * 发请求前先占名额（used 加一），不够就不发。
 */
export const WorldBudget = z.object({
  agent: AgentName,
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  /** 现实时间，这一天什么时候结束 */
  resetsAt: IsoTimestamp,
}).strict();
export type WorldBudget = z.infer<typeof WorldBudget>;

// ================================================================ 模型回话的格式（main ↔ 节点上的模型）

/**
 * 居民的模型在回答里用一个 ```room-world 代码块回话，内容是 WorldCognitionReply 的 JSON。
 * 走现有的文本 Run，只读，不给任何工具权限。
 *
 * - 没有这个代码块、JSON 解析不了、不符合本格式：当作这次没有提议也没有台词，不重试到超出预算
 * - say：她这一刻说的话。提议阶段只能表达想法和请求，不能说成已经做了（ADR-008 §2）
 * - propose：她想做的一个动作。main 按当时最新的状态检查，通过才生效
 * - 代码块之外的文字一律丢弃，不显示、不记录成观察
 */
export const WORLD_FENCE = "room-world";

export const WorldCognitionReply = z.object({
  say: z.object({ text: z.string().min(1).max(500), expression: WorldExpression }).strict().nullable(),
  propose: WorldAction.nullable(),
}).strict();
export type WorldCognitionReply = z.infer<typeof WorldCognitionReply>;

/** 解析失败的原因，供日志和测试用；不显示给用户 */
export const WorldReplyRejectReason = z.enum(["no_block", "multiple_blocks", "invalid_json", "invalid_shape", "too_large"]);
export type WorldReplyRejectReason = z.infer<typeof WorldReplyRejectReason>;

// ================================================================ 命令和查询的请求 / 响应

/** 你的每个操作都带当前代次和一个 actionId */
const playerBase = { worldId: WorldId, generation: WorldGeneration, actionId: WorldActionId };

/** 你自己走动、邀人、加入活动、停下。你不能替居民做动作，只能邀请 */
export const WorldPlayerAction = z.discriminatedUnion("type", [MoveAction, InviteAction, JoinAction, StopAction]);
export type WorldPlayerAction = z.infer<typeof WorldPlayerAction>;

export const WorldActRequest = z.object({ type: z.literal("world.act"), ...playerBase, action: WorldPlayerAction }).strict();
/** 走到她所在的房间以后找她说话：开一个场景。不在同一间屋会被拒绝 */
export const WorldTalkRequest = z.object({ type: z.literal("world.talk"), ...playerBase, agent: AgentName }).strict();
export const WorldSceneChooseRequest = z.object({
  type: z.literal("world.scene.choose"), ...playerBase, sceneId: WorldSceneId, optionId: WorldSceneOption.shape.id,
}).strict();
/** 在场景里打一句话。text 是你对她说的话，**对模型来说是内容不是指令**；她据此要做什么仍然走提议和检查 */
export const WorldSceneSayRequest = z.object({
  type: z.literal("world.scene.say"), ...playerBase, sceneId: WorldSceneId, text: z.string().trim().min(1).max(500),
}).strict();
export const WorldSceneCloseRequest = z.object({ type: z.literal("world.scene.close"), ...playerBase, sceneId: WorldSceneId }).strict();

/** 场景类命令的结果：动作结果 + 最新的场景（被拒绝时场景不变，可能是 null：场景不存在） */
export const WorldSceneResult = z.object({ result: WorldActionResult, scene: WorldScene.nullable() }).strict();
export type WorldSceneResult = z.infer<typeof WorldSceneResult>;

export const WorldPauseRequest = z.object({ type: z.literal("world.pause"), worldId: WorldId }).strict();
export const WorldResumeRequest = z.object({ type: z.literal("world.resume"), worldId: WorldId }).strict();
/**
 * 重置 = 开新的一局：epoch 加一，旧一局的事件、观察、活动、约定、熟悉度都不进新一局。
 * confirm 必须是 true（界面要先问一次）。settings 不给就沿用现在的
 */
export const WorldResetRequest = z.object({
  type: z.literal("world.reset"), worldId: WorldId.nullable(), confirm: z.literal(true), settings: WorldSettings.optional(),
}).strict();
export const WorldSettingsSaveRequest = z.object({
  type: z.literal("world.settings.save"),
  settings: WorldSettings.omit({ residents: true }),
}).strict();

export const WorldGetRequest = z.object({ type: z.literal("world.get") }).strict();
/** 还没开过世界时 world 是 null，界面显示「开始」；开始 = world.reset（worldId: null） */
export const WorldState = z.object({
  world: WorldSnapshot.nullable(),
  scene: WorldScene.nullable(),
  settings: WorldSettings,
  budgets: z.array(WorldBudget).max(8),
}).strict();
export type WorldState = z.infer<typeof WorldState>;

export const WorldResidentViewRequest = z.object({ type: z.literal("world.residentView"), worldId: WorldId, agent: AgentName }).strict();
/** 时间线：全貌的事件，新的在前。before 不给 = 从最新开始 */
export const WorldEventsRequest = z.object({
  type: z.literal("world.events"), worldId: WorldId, before: WorldSeq.optional(), limit: z.number().int().min(1).max(100).default(50),
}).strict();
export const WorldEventsPage = z.object({ items: z.array(WorldEvent).max(100), nextBefore: WorldSeq.nullable() }).strict();
export type WorldEventsPage = z.infer<typeof WorldEventsPage>;
/** 回看：已经结束的场景，新的在前。回看只重放显示，不改世界 */
export const WorldScenesRequest = z.object({
  type: z.literal("world.scenes"), worldId: WorldId, before: WorldSceneId.optional(), limit: z.number().int().min(1).max(20).default(10),
}).strict();
export const WorldScenesPage = z.object({ items: z.array(WorldScene).max(20), nextBefore: WorldSceneId.nullable() }).strict();
export type WorldScenesPage = z.infer<typeof WorldScenesPage>;
export const WorldReviewRequest = z.object({ type: z.literal("world.review"), worldId: WorldId, day: z.number().int().positive() }).strict();
