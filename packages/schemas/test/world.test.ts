import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS, ControlEvent, QUERIES, WorldAction, WorldActivity, WorldActRequest, WorldCognitionReply, WorldEvent, WorldItem,
  WorldBudget, WorldCommitment, WorldObservation, WorldResetRequest, WorldResidentView, WorldScene, WorldSceneLine, WorldSceneSayRequest, WorldSettings, WorldSettingsSaveRequest, WorldSnapshot, WorldState, WORLD_CHAT_MAX_CHARS, WORLD_MAX_RESIDENTS,
} from "../src/index";

const U = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const gen = { session: `wses_${U}`, runSeq: 0 };
const a = { kind: "resident", agent: "claude" } as const;
const b = { kind: "resident", agent: "codex" } as const;
const you = { kind: "player" } as const;
const activity = {
  id: `wavt_${U}`, kind: "cook", participants: [b], placeId: "kitchen", itemIds: ["pot"],
  startedAt: 600, endsAt: 640, state: "running", endReason: null,
};
const snapshot = {
  id: `world_${U}`, generation: gen, rulesVersion: "1", run: { state: "running" }, now: 610, asOf: "2026-11-15T16:00:00Z",
  minutesPerRealSecond: 1, lastSeq: 3,
  places: [
    { id: "living_room", label: "客厅", neighbors: ["kitchen"], owner: null },
    { id: "kitchen", label: "厨房", neighbors: ["living_room"], owner: null },
  ],
  residents: [
    { agent: "claude", placeId: "living_room", energy: 80, satiety: 50, mood: 70, activityId: null, cognition: { mode: "model" } },
    { agent: "codex", placeId: "kitchen", energy: 60, satiety: 40, mood: 60, activityId: activity.id, cognition: { mode: "routine", reason: "offline" } },
  ],
  player: { placeId: "living_room", activityId: null },
  items: [
    { kind: "unique", id: "book", label: "书", at: { kind: "held", by: a }, usedBy: null },
    { kind: "unique", id: "pot", label: "锅", at: { kind: "place", placeId: "kitchen" }, usedBy: activity.id },
    { kind: "stock", id: "ingredients", label: "食材", placeId: "kitchen", count: 3 },
  ],
  activities: [activity], commitments: [], sceneId: null,
};

test("snapshot: places, residents and items are unique and everyone stands in a real place", () => {
  assert.equal(WorldSnapshot.safeParse(snapshot).success, true);
  assert.equal(WorldSnapshot.safeParse({ ...snapshot, player: { placeId: "attic", activityId: null } }).success, false);
  assert.equal(WorldSnapshot.safeParse({ ...snapshot, residents: [snapshot.residents[0], snapshot.residents[0]] }).success, false);
  assert.equal(WorldSnapshot.safeParse({ ...snapshot, items: [snapshot.items[0], snapshot.items[0]] }).success, false);
  assert.equal(WorldSnapshot.safeParse({ ...snapshot, run: { state: "paused" } }).success, false);
  assert.equal(WorldSnapshot.safeParse({ ...snapshot, run: { state: "paused", by: "maintenance" } }).success, true);
});

test("a unique item is in exactly one place or one hand; stock has no holder", () => {
  assert.equal(WorldItem.safeParse({ kind: "unique", id: "book", label: "书", at: { kind: "place", placeId: "kitchen", by: a }, usedBy: null }).success, false);
  assert.equal(WorldItem.safeParse({ kind: "stock", id: "meal", label: "饭", placeId: "kitchen", count: 2, at: { kind: "held", by: a } }).success, false);
  assert.equal(WorldItem.safeParse({ kind: "stock", id: "meal", label: "饭", placeId: "kitchen", count: -1 }).success, false);
});

test("activity: endReason exists only after it ended", () => {
  assert.equal(WorldActivity.safeParse(activity).success, true);
  assert.equal(WorldActivity.safeParse({ ...activity, endReason: "done" }).success, false);
  assert.equal(WorldActivity.safeParse({ ...activity, state: "failed", endReason: null }).success, false);
  assert.equal(WorldActivity.safeParse({ ...activity, state: "failed", endReason: "missing_resource" }).success, true);
});

test("actions are a closed set; only 'later' carries a time", () => {
  assert.equal(WorldAction.safeParse({ type: "start", activity: "cook", itemId: "pot" }).success, true);
  assert.equal(WorldAction.safeParse({ type: "start", activity: "fly", itemId: null }).success, false);
  assert.equal(WorldAction.safeParse({ type: "give_money", amount: 5 }).success, false);
  const ans = { type: "answer", commitmentId: `wcom_${U}` };
  assert.equal(WorldAction.safeParse({ ...ans, answer: "later", dueAt: 900 }).success, true);
  assert.equal(WorldAction.safeParse({ ...ans, answer: "later", dueAt: null }).success, false);
  assert.equal(WorldAction.safeParse({ ...ans, answer: "accept", dueAt: 900 }).success, false);
});

test("the player can move, invite, join and stop, but cannot act for a resident or touch items directly", () => {
  const base = { type: "world.act", worldId: `world_${U}`, generation: gen, actionId: `wact_${U}` };
  assert.equal(WorldActRequest.safeParse({ ...base, action: { type: "move", to: "kitchen" } }).success, true);
  assert.equal(WorldActRequest.safeParse({ ...base, action: { type: "invite", to: b, activity: "set_table" } }).success, true);
  assert.equal(WorldActRequest.safeParse({ ...base, action: { type: "take", itemId: "book" } }).success, false);
  assert.equal(WorldActRequest.safeParse({ ...base, action: { type: "cancel", commitmentId: `wcom_${U}` } }).success, true);
  assert.equal(WorldActRequest.safeParse({ ...base, action: { type: "answer", commitmentId: `wcom_${U}`, answer: "later", dueAt: null } }).success, false);
  assert.equal(WorldActRequest.safeParse({ ...base, generation: { epoch: 1, runSeq: 0 } }).success, false, "generation is a session id, not a counter");
  assert.equal(WorldActRequest.safeParse({ ...base, action: { type: "move", to: "kitchen" }, actor: b }).success, false);
  const { generation: _g, ...noGen } = base;
  assert.equal(WorldActRequest.safeParse({ ...noGen, action: { type: "stop" } }).success, false);
});

test("events: a rejected action has no event shape; speech is text, not a state change", () => {
  const said = { type: "said", seq: 4, at: 611, placeId: "kitchen", speaker: b, text: "饭做好了", sceneId: null };
  const act = { type: "action", seq: 6, at: 612, placeId: "kitchen", actor: b, action: { type: "stop" }, activityId: null, commitmentId: null, sceneId: null, optionId: null };
  assert.equal(WorldEvent.safeParse(act).success, true);
  const chose = { type: "scene", seq: 7, at: 612, placeId: "kitchen", sceneId: `wscn_${U}`, step: "chose", optionId: "opt_leave", result: null };
  assert.equal(WorldEvent.safeParse(chose).success, true);
  assert.equal(WorldEvent.safeParse({ ...chose, optionId: null }).success, false);
  assert.equal(WorldEvent.safeParse({ ...chose, step: "opened" }).success, false);
  assert.equal(WorldEvent.safeParse(said).success, true);
  assert.equal(WorldEvent.safeParse({ ...said, produced: [{ itemId: "meal", count: 2 }] }).success, false);
  assert.equal(WorldEvent.safeParse({ type: "rejected", seq: 5, at: 611, reason: "item_busy" }).success, false);
  const ended = {
    type: "activity_ended", seq: 5, at: 640, placeId: "kitchen", activity: { ...activity, state: "completed", endReason: "done" },
    produced: [{ itemId: "meal", count: 2 }], consumed: [{ itemId: "ingredients", count: 1 }],
  };
  assert.equal(WorldEvent.safeParse(ended).success, true);
  assert.equal(WorldEvent.safeParse({ ...ended, produced: [{ itemId: "meal", count: 0 }] }).success, false);
});

test("observation: she either saw an event or heard a sentence; hearsay carries no link to the hidden event", () => {
  const o = { observer: "claude", seq: 3, at: 611 };
  assert.equal(WorldObservation.safeParse({ ...o, mode: "saw" }).success, true);
  assert.equal(WorldObservation.safeParse({ ...o, mode: "heard" }).success, true);
  assert.equal(WorldObservation.safeParse({ ...o, mode: "told" }).success, false);
  assert.equal(WorldObservation.safeParse({ ...o, mode: "heard", via: 2 }).success, false);
});

test("resident view: item beliefs come from what she saw; what she heard stays a sentence", () => {
  const view = {
    agent: "codex", worldId: `world_${U}`,
    knownItems: [{ itemId: "book", at: { kind: "place", placeId: "living_room" }, count: null, asOf: 300, seq: 2 }],
    seen: [], heard: [{ seq: 4, at: 611, speaker: a, text: "我把书收起来了" }],
  };
  assert.equal(WorldResidentView.safeParse(view).success, true);
  assert.equal(WorldResidentView.safeParse({ ...view, knownItems: [{ itemId: "book", at: null, count: null, asOf: 300 }] }).success, false);
  assert.equal(WorldResidentView.safeParse({ ...view, heard: [{ seq: 4, at: 611, speaker: a, text: "x", event: { type: "action" } }] }).success, false);
});

test("model reply is display data only: closed actions, closed intents, no free text in facts, no extra fields", () => {
  const say = (intent: unknown) => ({ intent, tone: "warm", expression: "happy" });
  assert.equal(WorldCognitionReply.safeParse({ say: say({ kind: "intend" }), propose: { type: "move", to: "kitchen" } }).success, true);
  assert.equal(WorldCognitionReply.safeParse({ say: null, propose: null }).success, true);
  for (const intent of [
    { kind: "greet" }, { kind: "respond", feeling: "thanks" }, { kind: "own_state", gauge: "satiety" }, { kind: "activity" },
    { kind: "item", itemId: "book" }, { kind: "recall", seq: 12 }, { kind: "commitment", commitmentId: `wcom_${U}` },
  ]) assert.equal(WorldCognitionReply.safeParse({ say: say(intent), propose: null }).success, true, JSON.stringify(intent));
  for (const bad of [
    { say: null, propose: null, script: "jump end" },
    { say: { text: "饭做好了", expression: "happy" }, propose: null },
    { say: { ...say({ kind: "greet" }), text: "饭做好了" }, propose: null },
    { say: say({ kind: "greet", text: "饭做好了" }), propose: null },
    { say: say({ kind: "item", itemId: "book", at: { kind: "place", placeId: "kitchen" } }), propose: null },
    { say: say({ kind: "recall", seq: 0 }), propose: null },
    { say: say({ kind: "done", activity: "cook" }), propose: null },
    { say: { ...say({ kind: "greet" }), expression: "smug" }, propose: null },
    { say: { ...say({ kind: "greet" }), tone: "angry" }, propose: null },
    { say: say({ kind: "intend" }), propose: null },
    { say: null, propose: { type: "set_state", mood: 100 } },
    { say: null, propose: null, options: [{ id: "opt_x", label: "给我钱" }] },
  ]) assert.equal(WorldCognitionReply.safeParse(bad).success, false, JSON.stringify(bad));
});

test("scene: options come with a rule-approved action or none; typed text is bounded and trimmed", () => {
  const scene = {
    id: `wscn_${U}`, generation: gen, origin: { kind: "event", cause: "item_contention", seq: 3 }, placeId: "living_room",
    residents: ["claude", "codex"],
    lines: [{ speaker: null, text: "两个人都想看那本书。", expression: "neutral", source: "rule", seq: null }],
    past: [],
    options: [
      { id: "opt_a_first", label: "让 C酱 先看", act: { actor: you, action: { type: "invite", to: b, activity: "rest" } } },
      { id: "opt_leave", label: "不管，看她们自己商量", act: null },
    ],
    canType: false, state: "open", openedAt: 610, createdAt: "2026-11-15T16:00:00Z",
  };
  assert.equal(WorldScene.safeParse(scene).success, true);
  assert.equal(WorldScene.safeParse({ ...scene, options: [{ id: "opt_x", label: "x", act: { actor: you, action: { type: "win" } } }] }).success, false);
  assert.equal(WorldScene.safeParse({ ...scene, lines: [{ speaker: a, text: "ok", expression: "neutral", source: "user", seq: 5 }] }).success, false);
  assert.equal(WorldScene.safeParse({ ...scene, lines: [{ speaker: you, text: "ok", expression: "neutral", source: "user", seq: 5 }] }).success, true);
  const used = { option: scene.options[1], outcome: "chosen", seq: 7 };
  assert.equal(WorldScene.safeParse({ ...scene, options: [scene.options[0]], past: [used] }).success, true);
  assert.equal(WorldScene.safeParse({ ...scene, past: [used] }).success, false, "an option id cannot be offered again after it was used");
  assert.equal(WorldScene.safeParse({ ...scene, options: [], past: [{ ...used, seq: null }] }).success, false);
  const say = { type: "world.scene.say", worldId: `world_${U}`, generation: gen, actionId: `wact_${U}`, sceneId: scene.id };
  assert.equal(WorldSceneSayRequest.parse({ ...say, text: "  你好  " }).text, "你好");
  assert.equal(WorldSceneSayRequest.safeParse({ ...say, text: "   " }).success, false);
});

test("commitment: an invite waits as 'asked' before it is a promise; budget is keyed by a local date", () => {
  const c = { id: `wcom_${U}`, by: b, to: you, activity: "set_table", dueAt: null, state: "asked", activityId: null, createdAt: 600 };
  assert.equal(WorldCommitment.safeParse(c).success, true);
  for (const state of ["pending", "deferred", "declined", "done", "cancelled", "expired"]) assert.equal(WorldCommitment.safeParse({ ...c, state }).success, true);
  assert.equal(WorldCommitment.safeParse({ ...c, state: "accepted" }).success, false);
  const budget = { agent: "claude", day: "2026-11-15", used: 3, limit: 60, resetsAt: "2026-11-16T00:00:00+08:00" };
  assert.equal(WorldBudget.safeParse(budget).success, true);
  assert.equal(WorldBudget.safeParse({ ...budget, day: "day 12" }).success, false);
});

test("reset needs explicit confirm; residents can change only through reset", () => {
  const settings = { dayRealMinutes: 24, dailyCognitionLimit: 60, residents: ["claude", "codex"] };
  assert.equal(WorldResetRequest.safeParse({ type: "world.reset", requestId: `wact_${U}`, worldId: null, confirm: true, settings }).success, true);
  assert.equal(WorldResetRequest.safeParse({ type: "world.reset", requestId: `wact_${U}`, worldId: null, confirm: false }).success, false);
  assert.equal(WorldResetRequest.safeParse({ type: "world.reset", requestId: `wact_${U}`, worldId: null }).success, false);
  assert.equal(WorldResetRequest.safeParse({ type: "world.reset", worldId: null, confirm: true }).success, false, "a reset must be retry-safe");
  assert.equal(WorldSettingsSaveRequest.safeParse({ type: "world.settings.save", settings }).success, false);
  assert.equal(WorldSettingsSaveRequest.safeParse({ type: "world.settings.save", settings: { dayRealMinutes: 24, dailyCognitionLimit: 0 } }).success, true);
});

test("world commands, queries and events are registered", () => {
  for (const c of ["world.act", "world.talk", "world.scene.choose", "world.scene.say", "world.scene.close", "world.pause", "world.resume", "world.reset", "world.settings.save"])
    assert.ok(c in COMMANDS, c);
  for (const q of ["world.get", "world.residentView", "world.events", "world.scenes", "world.review"]) assert.ok(q in QUERIES, q);
  assert.equal(COMMANDS["world.reset"].scope, "admin");
  assert.equal(ControlEvent.safeParse({ type: "world.updated", world: snapshot }).success, true);
  assert.equal(QUERIES["world.get"].response.safeParse({ world: null, scene: null, settings: { dayRealMinutes: 24, dailyCognitionLimit: 60, residents: ["claude"] }, budgets: [] }).success, true);
  assert.equal(QUERIES["world.review"].response.safeParse(null).success, true);
});

test("world.get before anything is set up: settings may be null only while there is no world", () => {
  const settings = { dayRealMinutes: 48, dailyCognitionLimit: 60, residents: ["claude"] };
  assert.equal(WorldState.safeParse({ world: null, scene: null, settings: null, budgets: [] }).success, true);
  assert.equal(WorldState.safeParse({ world: null, scene: null, settings, budgets: [] }).success, true);
  assert.equal(WorldState.safeParse({ world: snapshot, scene: null, settings, budgets: [] }).success, true);
  assert.equal(WorldState.safeParse({ world: snapshot, scene: null, settings: null, budgets: [] }).success, false);
  assert.equal(WorldState.safeParse({ world: null, scene: null, settings: { ...settings, residents: [] }, budgets: [] }).success, false, "不造空的入住名单");
});

test("a new home takes at most four residents; homes saved before the limit still read", () => {
  const base = { dayRealMinutes: 24, dailyCognitionLimit: 60 };
  const five = ["a", "b", "c", "d", "e"], eight = [...five, "f", "g", "h"];
  const reset = (settings?: unknown) => WorldResetRequest.safeParse({ type: "world.reset", requestId: "wact_01HZZZZZZZZZZZZZZZZZZZZZZ9", worldId: null, confirm: true, ...(settings ? { settings } : {}) }).success;
  assert.equal(WORLD_MAX_RESIDENTS, 4);
  assert.equal(reset({ ...base, residents: five.slice(0, 4) }), true);
  assert.equal(reset({ ...base, residents: five }), false, "新开的局不能超过 4 位");
  assert.equal(reset(), true, "不给 settings 时由 main 检查实际用上的名单");
  assert.equal(WorldSettings.safeParse({ ...base, residents: eight }).success, true, "旧存档的设置读得出");
  assert.equal(WorldState.safeParse({ world: null, scene: null, settings: { ...base, residents: eight }, budgets: [] }).success, true);
  assert.equal(WorldSettings.safeParse({ ...base, residents: [...eight, "i"] }).success, false);
});

test("small talk is free text beside the evidence-backed sentence, and never stands in for facts or actions", () => {
  const base = { tone: "warm", expression: "happy" };
  const parsed = WorldCognitionReply.parse({ say: { ...base, intent: { kind: "greet" } }, propose: null });
  assert.equal(parsed.say!.chat, null, "不写 chat 就是没有闲聊");
  assert.equal(WorldCognitionReply.parse({ say: { ...base, intent: { kind: "own_state", gauge: "satiety" }, chat: "  今天天气真好呀  " }, propose: null }).say!.chat, "今天天气真好呀");
  assert.equal(WorldCognitionReply.safeParse({ say: { ...base, intent: { kind: "chat" }, chat: "哈哈，好呀" }, propose: null }).success, true);
  assert.equal(WorldCognitionReply.safeParse({ say: { ...base, intent: { kind: "chat" } }, propose: null }).success, false, "只闲聊就得有闲聊");
  assert.equal(WorldCognitionReply.safeParse({ say: { ...base, intent: { kind: "chat" }, chat: "   " }, propose: null }).success, false);
  assert.equal(WorldCognitionReply.safeParse({ say: { ...base, intent: { kind: "greet" }, chat: "字".repeat(WORLD_CHAT_MAX_CHARS + 1) }, propose: null }).success, false);
  assert.equal(WorldCognitionReply.safeParse({ say: { ...base, intent: { kind: "intend" }, chat: "我去做饭了" }, propose: null }).success, false, "闲聊不能代替 propose");
  const line = { speaker: { kind: "resident", agent: "claude" }, text: "哈哈，好呀", expression: "happy", seq: 3 };
  assert.equal(WorldSceneLine.safeParse({ ...line, source: "chat" }).success, true);
  assert.equal(WorldSceneLine.safeParse({ ...line, source: "chat", speaker: { kind: "player" } }).success, false);
});
