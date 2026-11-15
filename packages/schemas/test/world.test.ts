import assert from "node:assert/strict";
import test from "node:test";
import {
  COMMANDS, ControlEvent, QUERIES, WorldAction, WorldActivity, WorldActRequest, WorldCognitionReply, WorldEvent, WorldItem,
  WorldBudget, WorldCommitment, WorldObservation, WorldResetRequest, WorldResidentView, WorldScene, WorldSceneSayRequest, WorldSettingsSaveRequest, WorldSnapshot,
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

test("model reply is display data only: closed actions, bounded text, no extra fields", () => {
  assert.equal(WorldCognitionReply.safeParse({ say: { text: "我去做饭吧", expression: "happy" }, propose: { type: "move", to: "kitchen" } }).success, true);
  assert.equal(WorldCognitionReply.safeParse({ say: null, propose: null }).success, true);
  for (const bad of [
    { say: null, propose: null, script: "jump end" },
    { say: { text: "x", expression: "smug" }, propose: null },
    { say: { text: "x".repeat(501), expression: "neutral" }, propose: null },
    { say: null, propose: { type: "set_state", mood: 100 } },
    { say: null, propose: null, options: [{ id: "opt_x", label: "给我钱" }] },
  ]) assert.equal(WorldCognitionReply.safeParse(bad).success, false);
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
