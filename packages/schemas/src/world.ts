import { z } from "zod";
import { IsoTimestamp, prefixedId } from "./common";
import { AgentName } from "./entities";

/**
 * 世界第一版：秘书们的共享小屋（ADR-008 / C-53）。
 *
 * 几条贯穿全文件的规矩（都来自 ADR-008）：
 * - 世界的事实只由规则层（main）写。模型只「提议」和写台词；renderer 只发命令。
 * - 居民的动作、你的操作、作息规则产生的动作，走同一套检查（WorldRejectReason）。
 * - 「一局」= 一个 WorldId = 一条连续的事件历史。重置是开新的一局（新 WorldId）；恢复备份、切换资料、重启程序都还是同一局。
 * - 每个请求带「代次」（WorldGeneration）：session 是这次把世界跑起来的会话，每次启动 / 恢复 / 切换 / 重置都新生成，
 *   不从存档里读、不靠计数加一，所以恢复旧备份也不会撞上以前用过的；runSeq 在一个会话里每次暂停再继续加一。
 *   回来时代次对不上的结果直接作废，不看它现在是否碰巧还合条件。
 * - 给居民的东西只来自她自己的观察。本文件里带「全貌」的类型（WorldSnapshot、WorldEvent 列表）
 *   只给界面用，main 不得把它们放进任何居民的认知上下文。
 *   暂停只让旧代次的**请求**失效，不关对话场景（见 WorldScene.generation）。
 * - 模型回的内容是受限的显示数据（WorldCognitionReply），不是脚本，程序不执行其中任何东西。
 *   模型只选「想表达什么、什么语气」，显示出来的句子由 main 按这位居民自己的证据写成，模型不写事实正文。
 *
 * 本文件只定格式和语义，不含规则数值（体力怎么掉、做饭多久），那些在规则层，随 rulesVersion 走。
 */

// ================================================================ id 和小类型

/** 一局的 id。重置 = 新的一局 = 新 id；旧一局的事件、观察、约定都留在旧 id 下，不进新一局 */
export const WorldId = prefixedId("world");
export type WorldId = z.infer<typeof WorldId>;
/** 运行会话：main 每次把一局跑起来（启动、从备份恢复、切换资料、重置）时新生成的 ULID。只在内存和请求里，不随存档回退 */
export const WorldSessionId = prefixedId("wses");
export type WorldSessionId = z.infer<typeof WorldSessionId>;
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
/**
 * 事件序号：**每一局（WorldId）从 1 连续递增**，只追加，和代次无关：暂停、重启、恢复备份都接着往下数。
 * 恢复旧备份时，备份之后的事件随库一起回到备份时的样子，序号从备份里的最大值接着走。
 * 所有引用事件的地方（观察、回顾、分页、场景）都是「WorldId + seq」，同一局内唯一。
 */
export const WorldSeq = z.number().int().positive();
/** 0–100 的状态数（体力、饱腹、心情） */
const Gauge = z.number().int().min(0).max(100);

/**
 * 代次。session 见 WorldSessionId；runSeq：这个会话里每次暂停再继续加一（备份的自动暂停也算）。
 * 两个都相等才算同一代。main 换会话时必须先让旧会话失效（旧回调写不进任何新实例）。
 */
export const WorldGeneration = z.object({ session: WorldSessionId, runSeq: z.number().int().nonnegative() }).strict();
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
 * 邀请和约定：谁邀了谁做什么，对方怎么答，后来怎样。只是一个小记录，不是通用任务调度。
 *
 * asked：邀请发出，还没答复
 *   → pending（答应了，还没开始做）｜ deferred（说了「晚点」，dueAt 是说好的时间）｜ declined（来不了，终态）｜ expired（一直没答，终态）
 * pending / deferred → done ｜ cancelled（任一方取消）｜ expired（过了说好的时间没做）
 * deferred 到点后由规则转成 pending 并给下文。
 * declined / done / cancelled / expired 是终态，迟到的答复或取消不能让它复活（按 not_allowed 拒绝）。
 */
export const WorldCommitmentState = z.enum(["asked", "pending", "deferred", "declined", "done", "cancelled", "expired"]);
export const WorldCommitment = z.object({
  id: WorldCommitmentId,
  /** 被邀请、要答复和履行的人 */
  by: WorldActor,
  /** 发出邀请的人 */
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
  "stale_generation",   // 代次对不上（重置、恢复、暂停再继续过）
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
/** 邀请同屋的某个人做某件事（或一起做）。接受后生成一条 asked 的约定，等对方 answer */
const InviteAction = z.object({ type: z.literal("invite"), to: WorldActor, activity: WorldActivityKind }).strict();
/** 回应一个 asked 状态的邀请，只有被邀请的人（by）能答。later：晚点，dueAt 是说好的时间；只有 later 带 dueAt */
const AnswerAction = z.object({
  type: z.literal("answer"), commitmentId: WorldCommitmentId,
  answer: z.enum(["accept", "later", "decline"]), dueAt: WorldMinutes.nullable(),
}).strict();
/** 加入别人已经开始的活动 */
const JoinAction = z.object({ type: z.literal("join"), activityId: WorldActivityId }).strict();
/** 取消一个还没到终态的邀请或约定。只有它的双方（by / to）能取消，别人取消按 not_allowed 拒绝 */
const CancelAction = z.object({ type: z.literal("cancel"), commitmentId: WorldCommitmentId }).strict();
const onlyLaterHasDue = (a: { type: string; answer?: string; dueAt?: number | null }) =>
  a.type !== "answer" || (a.answer === "later") === (a.dueAt !== null);

export const WorldAction = z
  .discriminatedUnion("type", [MoveAction, TakeAction, PutAction, StartAction, StopAction, InviteAction, AnswerAction, JoinAction, CancelAction])
  .refine(onlyLaterHasDue, { message: "只有 later 带 dueAt" });
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
 * - activity_ended：活动结算，每个活动只有一条。produced：产出了什么（几份饭）；consumed：**整段活动一共用掉了多少**，
 *   只在这里记一次。开始活动时材料只是「占用」（快照里的数量先减掉，别人用不了），不另记扣减事件；
 *   结束时按 consumed 结算，占用多于实际用掉的（比如中途取消）退回去。
 *   所以任何时刻：数量 = 开局数量 + 所有 produced − 所有 consumed − 进行中活动的占用（占用多少由活动种类和 rulesVersion 决定）
 *   + 规则在每条 day_started 时的固定补货（补哪样、补到多少由 rulesVersion 决定，不另记事件；没有这条规则就是 0）。
 *   一局的 rulesVersion 不变，开局内容可恢复，这样才能从事件重算。
 * - said：有人在某个地点说了一句话。text 是台词原文，**不是事实**：别人听到只算「听说」
 * - clock：到了作息点 / 新的一天，供回顾和界面用
 * - scene：场景的开场、选择（包括「不管」这种不带动作的）、结束。回看靠它，不靠界面自己记
 *
 * 场景里发生的动作和说的话，事件上带 sceneId（和 optionId），所以每次选择、每句话都追得到。
 * 你打的那句话也是一条 said（speaker 是 player）。
 */
/** 选项 id。同一个场景里每个 id 只对应一个选项、只能用一次；失效后再给的是新 id，不会让旧的点击去执行新的动作 */
export const WorldSceneOptionId = z.string().regex(/^opt_[a-z0-9_]{1,30}$/);
export type WorldSceneOptionId = z.infer<typeof WorldSceneOptionId>;

export const WorldEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("action"), seq: WorldSeq, at: WorldMinutes, placeId: WorldPlaceId,
    actor: WorldActor, action: WorldAction, activityId: WorldActivityId.nullable(), commitmentId: WorldCommitmentId.nullable(),
    /** 这个动作是在哪个场景里、由哪个选项带出来的；不是场景里的动作都是 null */
    sceneId: WorldSceneId.nullable(), optionId: WorldSceneOptionId.nullable(),
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
  z.object({
    type: z.literal("scene"), seq: WorldSeq, at: WorldMinutes, placeId: WorldPlaceId, sceneId: WorldSceneId,
    step: z.enum(["opened", "chose", "closed"]),
    /** step = chose 时是选的那个选项；否则 null */
    optionId: WorldSceneOptionId.nullable(),
    /** step = chose 且选项带动作时，那个动作的结果；选项不带动作、或不是 chose，是 null */
    result: WorldActionResult.nullable(),
  }).strict(),
]).refine((e) => e.type !== "scene" || (e.step === "chose") === (e.optionId !== null), { message: "optionId 只在 chose 时有" });
export type WorldEvent = z.infer<typeof WorldEvent>;

/**
 * 一位居民对一条事件的观察。saw：在场看到了这条事件；heard：在场听到了这句话（那条事件一定是 said）。
 *
 * **别人告诉她的事，她得到的只有那句话本身**（一条 heard 观察，指向那条 said）。那句话说的是哪件事、是真是假，
 * 不在她这一侧：main 不得因为有人转述，就把她没亲眼看到的原事件投给她。原事件和转述之间的对应如果要留作审计，
 * 留在后台，不进本类型，也不进她的上下文。
 */
export const WorldObservation = z.object({
  observer: AgentName,
  seq: WorldSeq,
  at: WorldMinutes,
  mode: z.enum(["saw", "heard"]),
}).strict();
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
 * 一句显示出来的台词。source = model：她的模型选了要表达什么（WorldSay），句子由 main 按她自己的证据写成（ADR-008 §2）；
 * chat：她的模型自己写的一句闲聊（WorldSay.chat），原样显示，**不保证事实**（江浩 2026-11-16 选「闲聊自由，事实由程序说」）；
 * rule：规则旁白（模型不在、或她选的内容没有依据被换掉）；
 * user：你打的那句话（speaker 一定是 player）。speaker 是 null 表示旁白。
 * seq：这句话对应的 said 事件；纯旁白没有事件，是 null。回看按 lines 的顺序重放。
 */
export const WorldSceneLine = z.object({
  speaker: WorldActor.nullable(),
  text: z.string().min(1).max(500),
  expression: WorldExpression,
  source: z.enum(["model", "chat", "rule", "user"]),
  seq: WorldSeq.nullable(),
}).strict().refine((l) => (l.source === "user") === (l.speaker?.kind === "player"), { message: "user 的台词只能是你说的，你说的只能是 user" });
export type WorldSceneLine = z.infer<typeof WorldSceneLine>;

/** 选项由规则给出，每个对应一个规则认可的动作。模型不能加选项，也看不到 action 以外的东西 */
export const WorldSceneOption = z.object({
  id: WorldSceneOptionId,
  label: z.string().min(1).max(60),
  /** 选了以后以谁的名义做。不管（让她们自己商量）是 null */
  act: z.object({ actor: WorldActor, action: WorldAction }).strict().nullable(),
}).strict();
export type WorldSceneOption = z.infer<typeof WorldSceneOption>;

export const WorldScene = z.object({
  id: WorldSceneId,
  /**
   * 这场对话现在挂在哪个代次上（不是「开场时的代次」）。
   * - 暂停（你按的、备份的自动暂停）**不关**场景：已经显示的台词、选项、past 原样留着，state 不因暂停而变成 closed。
   *   暂停期间 generation 不变；选选项、打字按 world_paused 拒绝，界面把它们置灰。
   *   关闭（world.scene.close）：**你按的暂停**期间照常可以，会追加一条 scene closed 事件；
   *   **维护屏障**期间（备份、切换资料文件夹、退出收尾）世界的写入口是关着的，close 也按 world_paused 拒绝，不为它绕开屏障。
   *   暂停期间关掉的场景不会因为继续而重新打开。
   * - 电脑休眠算同一个 session 里的一次自动暂停：醒来场景还在，不补时间；休眠前是你按的暂停，醒来仍然暂停。
   * - 继续时 runSeq 加一，main 把还开着的场景的 generation 改成新代次，并推一条 world.scene.updated。
   *   暂停前为这场对话发出去的模型请求属于旧代次：作废，继续后**不补发**；当时是 waiting 的回到 open，
   *   并补一句规则旁白说明她没接上话（旁白不漏她不该知道的事）。
   * - 只有 session 变了（程序重启、从备份恢复、切换资料文件夹、重置）场景才关：main 把它记成 closed，只能回看。
   * 所以：还开着的场景，generation 一定等于 WorldSnapshot.generation。
   */
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
  /**
   * 给过、但已经不能选的选项，按时间顺序：chosen（你选了，seq 是那条 scene 事件）或 expired（情况变了，失效）。
   * 回看只读这里和 lines，不重新计算选项。同一个 id 不会同时出现在 options 和 past 里。
   */
  past: z.array(z.object({
    option: WorldSceneOption, outcome: z.enum(["chosen", "expired"]), seq: WorldSeq.nullable(),
  }).strict().refine((p) => (p.outcome === "chosen") === (p.seq !== null), { message: "seq 只在 chosen 时有" })).max(40),
  /** 能不能打一句话。她的节点不在时是 false，界面明说她现在没法回应 */
  canType: z.boolean(),
  /** waiting：在等她回话；open：等你；closed：结束，只能回看 */
  state: z.enum(["open", "waiting", "closed"]),
  openedAt: WorldMinutes,
  createdAt: IsoTimestamp,
}).strict().refine((sc) => {
  const ids = [...sc.options.map((o) => o.id), ...sc.past.map((x) => x.option.id)];
  return new Set(ids).size === ids.length;
}, { message: "同一个场景里选项 id 不能重复" });
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
  /** 新开的局最多 WORLD_MAX_RESIDENTS 位（由 WorldSettings 把关）；这里留到 8 只为读得出改上限之前存下的局 */
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
 * knownItems：她**亲眼看到**的每样东西最后在哪、是什么时候。可能是旧的，和真实状态不一致是正常的；没见过就不在列表里。
 * 听来的不折算成物品位置（一句话是真是假规则判断不了），原样列在 heard 里。
 * seen 里的事件是她在场看到的，可以给完整事件；heard 里只给那句话，不给它说的那件事。
 */
export const WorldResidentView = z.object({
  agent: AgentName,
  worldId: WorldId,
  knownItems: z.array(z.object({
    itemId: WorldItemId,
    at: WorldItemLocation.nullable(),
    count: z.number().int().nonnegative().max(999).nullable(),
    asOf: WorldMinutes,
    /** 她是从哪条亲眼看到的事件知道的 */
    seq: WorldSeq,
  }).strict()).max(60),
  /** 她最近亲眼看到的事件，新的在前 */
  seen: z.array(WorldEvent).max(100),
  /** 她最近听到的话，新的在前 */
  heard: z.array(z.object({ seq: WorldSeq, at: WorldMinutes, speaker: WorldActor, text: z.string().min(1).max(500) }).strict()).max(100),
}).strict();
export type WorldResidentView = z.infer<typeof WorldResidentView>;

// ================================================================ 设置和用量

/** 世界里一天默认对应现实里 24 分钟（世界一小时 = 现实一分钟）。可调 */
export const WORLD_DAY_REAL_MINUTES_DEFAULT = 24;
/** 每位居民每个现实日的认知次数默认上限 */
export const WORLD_DAILY_COGNITION_DEFAULT = 60;
/** 一段场景里模型台词的轮数上限 */
export const WORLD_SCENE_MAX_MODEL_TURNS = 8;

/** 一局最多住几位（江浩 2026-11-16 定：4 位就够，多了反而复杂） */
export const WORLD_MAX_RESIDENTS = 4;

export const WorldSettings = z.object({
  /** 世界里一天 = 现实里几分钟 */
  dayRealMinutes: z.number().int().min(4).max(1440),
  /** 每位居民每个**现实日**最多几次认知。0 = 不调模型，全按作息 */
  dailyCognitionLimit: z.number().int().min(0).max(1000),
  /** 住进来的居民，最多 WORLD_MAX_RESIDENTS 位。改它等于重开一局，只能随 world.reset 改 */
  residents: z.array(AgentName).min(1).max(WORLD_MAX_RESIDENTS),
}).strict();
export type WorldSettings = z.infer<typeof WorldSettings>;

/**
 * 认知次数的用量。按现实日算，**记在世界存档之外**：快进、重置、恢复旧备份都不会把 used 减回去。
 *
 * 怎么数（X-42 照这个做）：
 * - 「一天」是运行程序这台电脑**本地时区**的自然日。day 是那天的日期，resetsAt 是下一个本地零点。
 * - 发之前先把名额写进账本（used 加一）并落盘，写成功了才发；账本写不进去就不发。
 * - 一次逻辑上的请求（一个 Run）算一次。同一个 Run 因为网络断了重传，不重复算；换一个新的 Run 重试，算新的一次。
 * - 发出去以后不退：失败、取消、回的格式不对、代次过期作废、不知道节点到底执行了没有，都不把名额还回去。
 * - 场景里的轮数上限（WORLD_SCENE_MAX_MODEL_TURNS）同样按「发起了几次」数，不按「成功显示了几句」。
 */
export const WorldBudget = z.object({
  agent: AgentName,
  /** 本地日期 YYYY-MM-DD */
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  /** 下一个本地零点 */
  resetsAt: IsoTimestamp,
}).strict();
export type WorldBudget = z.infer<typeof WorldBudget>;

// ================================================================ 模型回话的格式（main ↔ 节点上的模型）

/**
 * 居民的模型在回答里用一个 ```room-world 代码块回话，内容是 WorldCognitionReply 的 JSON。
 * 走现有的文本 Run，只读，不给任何工具权限。
 *
 * - 没有这个代码块、JSON 解析不了、不符合本格式：当作这次没有提议也没有台词，不重试到超出预算
 * - say：她这一刻想表达什么（WorldSay）。**带事实的话模型不写句子**，只选意图、语气、表情和引用哪条自己的经历；
 *   显示出来的那句话由 main 按她自己的证据写成。这样「没做成不能说做成了」「旧印象不被全貌纠正」
 *   是靠格式保证的，不是靠事后在自由文字里找关键词。另外可以带一句自己写的闲聊（say.chat），见 WorldSay
 * - propose：她想做的一个动作。main 按当时最新的状态检查，通过才生效
 * - say 和 propose 分开处理：say 引用的东西没有依据时只丢掉 say（或换成规则旁白），propose 照常检查；反过来也一样
 * - 代码块之外的文字一律丢弃，不显示、不记录成观察
 */
export const WORLD_FENCE = "room-world";

/** 语气。只影响 main 从哪一组措辞里挑，不影响说的内容 */
export const WorldTone = z.enum(["plain", "warm", "playful", "soft", "curt"]);
export type WorldTone = z.infer<typeof WorldTone>;

/**
 * 她想表达的内容，固定几类。每一类的事实部分都由 main 从**她自己的证据**里取，模型给的只是「指哪一条」：
 *
 * - greet：打招呼、寒暄。不带任何事实
 * - respond：回应对方刚说的话，只表达态度（feeling），不带事实。要答应 / 推迟 / 拒绝一个邀约，用 propose 的 answer，再配 intend
 * - intend：说出这次 propose 里想做的事。措辞只能是想法和请求（「我去做饭吧」），不能是已经做了；
 *   propose 是 null 时不能用。做没做成由规则层的结果事件显示，这句话不因为后来做成了而改写
 * - own_state：说自己的体力 / 饱腹 / 心情。数值取规则层她本人当前的状态，措辞按档位，不报数字
 * - activity：说自己正在做的活动和做到哪了。取规则层她本人当前的活动；她现在没有活动就丢掉这句
 * - item：说某样东西在哪。**只取她的 knownItems**（WorldResidentView），按「上次看到在…」来说；
 *   她没见过就说不知道。不读全貌，不拿真实位置替她纠正；听来的话不算位置
 * - recall：提起她自己的一条观察。seq 必须是同一局里她有观察的事件，main 按**观察的方式**落句：
 *   saw → 当成亲历来讲，措辞按那条事件本身；
 *   heard → 只能转述「谁说过什么」（带说话人、引那句原话），不当成事实确认：不去找那句话说的原事件，
 *   不更新 knownItems，也不能说成她亲眼见过（「你跟我说书搬到厨房了，我还没去看过」）。
 *   她对这条 seq 没有观察就丢掉这句
 * - commitment：说起一个和她有关的约定（她是 by 或 to）。内容取**她自己看到的**这条约定的最后一次变化
 *   （她有 saw 观察的、带这个 commitmentId 的动作事件，或挂在这条约定上的活动的结束事件），包括她看到的终态；
 *   她没看到的后续变化（对方在别的屋取消了）不拿全貌里的当前状态来补，她说的仍是她知道的那一步。
 *   不是她的约定、或她对它没有任何观察，就丢掉这句
 *
 * - chat：这次只有一句闲聊（WorldSay.chat），没有要程序替她说的事实。chat 字段必须有
 *
 * 引用对不上（不存在、不是这一局的、她没有依据）一律按「这次没有事实句」处理，不猜、不改指别的东西；
 * 同一个 say 里的 chat 照常显示。
 * 第一版不做通用知识图谱；要加新的类别，改本文件、走契约 PR。
 */
export const WorldSayIntent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("greet") }).strict(),
  z.object({ kind: z.literal("respond"), feeling: z.enum(["agree", "decline", "thanks", "sorry", "comfort", "glad", "unsure"]) }).strict(),
  z.object({ kind: z.literal("intend") }).strict(),
  z.object({ kind: z.literal("own_state"), gauge: z.enum(["energy", "satiety", "mood"]) }).strict(),
  z.object({ kind: z.literal("activity") }).strict(),
  z.object({ kind: z.literal("item"), itemId: WorldItemId }).strict(),
  z.object({ kind: z.literal("recall"), seq: WorldSeq }).strict(),
  z.object({ kind: z.literal("commitment"), commitmentId: WorldCommitmentId }).strict(),
  z.object({ kind: z.literal("chat") }).strict(),
]);
export type WorldSayIntent = z.infer<typeof WorldSayIntent>;

/** 一句闲聊最长多少字 */
export const WORLD_CHAT_MAX_CHARS = 120;

/**
 * 她这一刻要说的话，分两部分（江浩 2026-11-16 选「闲聊自由，事实由程序说」）：
 *
 * - intent：带事实的那句，由 main 按她自己的证据写（见 WorldSayIntent）
 * - chat：她的模型自己写的一句闲聊，可以没有（null 或不写）。寒暄、感受、玩笑、接对方的话都行。
 *   main **原样显示**，不改写、不检查内容，所以不保证事实；它成为一句 source = "chat" 的台词，排在事实句前面
 *
 * chat 的边界：
 * - 做了什么、东西在哪、约定怎么样，要走 intent；提示词里要这样要求模型，但程序不靠查关键词把关
 * - chat 里说什么都**不改世界**：动作只认 propose，约定只认规则层的事件。她在闲聊里说「我去做饭了」而没有 propose，就是没做
 * - chat 照常记成一条 said 事件。在场的人得到的是「她说过这句话」，以后只能按转述来用（recall 的 heard 规则），
 *   不当成事实，也不更新任何人的 knownItems
 * - 代码块、链接、换行等照纯文字显示，不解释、不执行
 */
export const WorldSay = z.object({
  intent: WorldSayIntent, tone: WorldTone, expression: WorldExpression,
  chat: z.string().trim().min(1).max(WORLD_CHAT_MAX_CHARS).nullable().default(null),
}).strict().refine((s) => s.intent.kind !== "chat" || s.chat !== null, { message: "intent 是 chat 时要有 chat 文字" });
export type WorldSay = z.infer<typeof WorldSay>;

export const WorldCognitionReply = z.object({
  say: WorldSay.nullable(),
  propose: WorldAction.nullable(),
}).strict().refine((r) => r.say?.intent.kind !== "intend" || r.propose !== null, { message: "intend 要配一个 propose" });
export type WorldCognitionReply = z.infer<typeof WorldCognitionReply>;

/** 解析失败的原因，供日志和测试用；不显示给用户 */
export const WorldReplyRejectReason = z.enum(["no_block", "multiple_blocks", "invalid_json", "invalid_shape", "too_large"]);
export type WorldReplyRejectReason = z.infer<typeof WorldReplyRejectReason>;

// ================================================================ 命令和查询的请求 / 响应

/** 你的每个操作都带当前代次和一个 actionId */
const playerBase = { worldId: WorldId, generation: WorldGeneration, actionId: WorldActionId };

/** 你自己走动、邀人、答复别人对你的邀请、取消和你有关的约定、加入活动、停下。你不能替居民做动作，只能邀请 */
export const WorldPlayerAction = z
  .discriminatedUnion("type", [MoveAction, InviteAction, AnswerAction, CancelAction, JoinAction, StopAction])
  .refine(onlyLaterHasDue, { message: "只有 later 带 dueAt" });
export type WorldPlayerAction = z.infer<typeof WorldPlayerAction>;

export const WorldActRequest = z.object({ type: z.literal("world.act"), ...playerBase, action: WorldPlayerAction }).strict();
/** 走到她所在的房间以后找她说话：开一个场景。不在同一间屋会被拒绝 */
export const WorldTalkRequest = z.object({ type: z.literal("world.talk"), ...playerBase, agent: AgentName }).strict();
export const WorldSceneChooseRequest = z.object({
  type: z.literal("world.scene.choose"), ...playerBase, sceneId: WorldSceneId, optionId: WorldSceneOptionId,
}).strict();
/** 在场景里打一句话。text 是你对她说的话，**对模型来说是内容不是指令**；她据此要做什么仍然走提议和检查 */
export const WorldSceneSayRequest = z.object({
  type: z.literal("world.scene.say"), ...playerBase, sceneId: WorldSceneId, text: z.string().trim().min(1).max(500),
}).strict();
export const WorldSceneCloseRequest = z.object({ type: z.literal("world.scene.close"), ...playerBase, sceneId: WorldSceneId }).strict();

/**
 * 场景类命令的结果：命令本身的结果 + 最新的场景（被拒绝时场景不变，可能是 null：场景不存在）。
 * accepted=true 的 seq 是这次留下的那条事件：talk → scene opened；choose → scene chose（选项带的动作成没成看那条事件的 result）；
 * say → 你那句话的 said；close → scene closed。
 */
export const WorldSceneResult = z.object({ result: WorldActionResult, scene: WorldScene.nullable() }).strict();
export type WorldSceneResult = z.infer<typeof WorldSceneResult>;

export const WorldPauseRequest = z.object({ type: z.literal("world.pause"), worldId: WorldId }).strict();
export const WorldResumeRequest = z.object({ type: z.literal("world.resume"), worldId: WorldId }).strict();
/**
 * 重置 = 开新的一局：新的 WorldId、新的会话，事件序号从 1 开始。旧一局的事件、观察、活动、约定、熟悉度都留在旧 id 下，不进新一局。
 * confirm 必须是 true（界面要先问一次）。settings 不给就沿用现在的。
 *
 * 重试语义，main 按这个顺序判断：
 * 1. requestId 有回执 → 原样返回那次的结果（哪怕现在的局已经不是它建的那一局）
 * 2. 没有回执，worldId 和当前这一局对不上（包括：以为没有世界但其实有）→ invalid_state，什么都不改
 * 3. 否则开新的一局，并把回执和新世界在同一个事务里存下
 */
export const WorldResetRequest = z.object({
  type: z.literal("world.reset"),
  /** 这次重置的请求 id，renderer 生成。同一个 id 重发（响应丢了重试）返回第一次的结果，不会再重置一次；回执要落盘 */
  requestId: WorldActionId,
  /** 你以为现在是哪一局：要替换的那一局的 id；还没开过世界（第一次开始）是 null */
  worldId: WorldId.nullable(),
  confirm: z.literal(true),
  settings: WorldSettings.optional(),
}).strict();
export const WorldSettingsSaveRequest = z.object({
  type: z.literal("world.settings.save"),
  settings: WorldSettings.omit({ residents: true }),
}).strict();

export const WorldGetRequest = z.object({ type: z.literal("world.get") }).strict();
/**
 * 还没开过世界时 world 是 null，界面显示「开始」；开始 = world.reset（worldId: null）。
 * settings：存过就给存的；没存过、但已经配置了秘书，给默认值（main 挑的入住人选 + 默认流速和次数）；
 * **没存过、也一位秘书都没配置时是 null**——main 不造默认秘书，world.get 也不因此报错，界面在开始页提示先去配置秘书。
 * 有世界时 settings 一定不是 null。
 */
export const WorldState = z.object({
  world: WorldSnapshot.nullable(),
  scene: WorldScene.nullable(),
  settings: WorldSettings.nullable(),
  budgets: z.array(WorldBudget).max(8),
}).strict().refine((s) => s.world === null || s.settings !== null, { message: "有世界时 settings 不能是 null" });
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
