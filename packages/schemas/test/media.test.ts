import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS,
  ControlEvent,
  DrawRequest,
  MEDIA_JOB_TRANSITIONS,
  MEDIA_LIST_MESSAGE_IDS_MAX,
  MEDIA_LIST_PER_MESSAGE_KIND_LATEST,
  MEDIA_LIST_PER_MESSAGE_KIND_MAX,
  MediaJobKind,
  MediaJob,
  MediaJobState,
  NodeHealth,
  QUERIES,
  RemoteEvent,
  RemoteProfileQuota,
  SpeechClip,
  StartRunRequest,
  VoiceOption,
  canTransition,
  pickMessageMediaJobs,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const NOW = "2026-10-23T18:00:00+08:00";
const sha = (c: string) => c.repeat(64);

const draw = { prompt: "一只在月光下看书的小鲸鱼", size: "1024x1024", backend: "auto" };
const job = {
  id: `mjob_${ID}`,
  kind: "draw",
  state: "queued",
  authorization: "user_tap",
  source: { kind: "chat", conversationId: `conv_${ID}`, messageId: `cmsg_${ID}`, agent: "codex" },
  intentHash: null,
  draw,
  route: null,
  remoteRunId: null,
  result: null,
  speech: null,
  failure: null,
  cancelReason: null,
  createdAt: NOW,
  startedAt: null,
  finishedAt: null,
};
const result = {
  ref: `img_${ID}`,
  sha256: sha("a"),
  backend: "comfyui",
  model: "qwen-image",
  prompt: draw.prompt,
  size: "1024x1024",
  seed: 42,
  workflowHash: sha("c"),
};

const route = {
  backend: "comfyui",
  manual: false,
  confirmedOverThreshold: false,
  fallbackReason: "quota_threshold",
  quotaBefore: null,
  quotaAfter: null,
};
const T1 = "2026-10-23T18:00:05+08:00";
const T2 = "2026-10-23T18:00:40+08:00";
const done = { ...job, state: "succeeded", route, result, startedAt: T1, finishedAt: T2 };

describe("media jobs (C-42b)", () => {
  it("exactly one terminal state: terminal states have no way out", () => {
    for (const s of ["succeeded", "failed", "cancelled", "timed_out"] as const) {
      assert.deepEqual(MEDIA_JOB_TRANSITIONS[s], [], s);
    }
    assert.ok(canTransition(MEDIA_JOB_TRANSITIONS, "queued", "cancelled"));
    assert.ok(canTransition(MEDIA_JOB_TRANSITIONS, "running", "cancelled"));
    assert.equal(canTransition(MEDIA_JOB_TRANSITIONS, "queued", "succeeded"), false);
    assert.deepEqual(Object.keys(MEDIA_JOB_TRANSITIONS).sort(), [...MediaJobState.options].sort());
  });

  it("MediaJob: state and failure / cancelReason / result must agree", () => {
    assert.ok(MediaJob.safeParse(job).success);
    assert.equal(MediaJob.safeParse({ ...job, draw: null }).success, false, "draw job needs draw");
    const fail = { reason: "backend_unavailable", message: "x" };
    assert.equal(MediaJob.safeParse({ ...job, state: "failed", finishedAt: T2 }).success, false, "failed needs failure");
    assert.ok(MediaJob.safeParse({ ...job, state: "failed", failure: fail, finishedAt: T2 }).success, "failed straight from queued");
    assert.equal(MediaJob.safeParse({ ...job, state: "cancelled", finishedAt: T2 }).success, false, "cancelled needs reason");
    assert.ok(MediaJob.safeParse({ ...job, state: "cancelled", cancelReason: "app_restart", finishedAt: T2 }).success);
    assert.equal(MediaJob.safeParse({ ...done, result: null }).success, false, "succeeded draw needs result");
    assert.ok(MediaJob.safeParse(done).success);
    assert.equal(MediaJob.safeParse({ ...job, authorization: "model_said_so" }).success, false);
  });

  it("MediaJob: timestamps follow the state", () => {
    assert.equal(MediaJob.safeParse({ ...job, startedAt: T1 }).success, false, "queued has not started");
    assert.ok(MediaJob.safeParse({ ...job, state: "running", startedAt: T1, route }).success);
    assert.equal(MediaJob.safeParse({ ...job, state: "running" }).success, false, "running needs startedAt");
    assert.equal(MediaJob.safeParse({ ...job, state: "running", startedAt: T1, finishedAt: T2 }).success, false);
    assert.equal(MediaJob.safeParse({ ...done, finishedAt: null }).success, false, "terminal needs finishedAt");
    assert.equal(MediaJob.safeParse({ ...done, startedAt: null }).success, false, "succeeded must have started");
    assert.equal(MediaJob.safeParse({ ...job, state: "timed_out", finishedAt: T2 }).success, false, "timed_out must have started");
    assert.ok(MediaJob.safeParse({ ...job, state: "timed_out", startedAt: T1, finishedAt: T2 }).success);
  });

  it("MediaJob: route, result and request agree", () => {
    assert.equal(MediaJob.safeParse({ ...done, route: null }).success, false, "result needs a route");
    assert.equal(MediaJob.safeParse({ ...done, result: { ...result, backend: "codex" } }).success, false, "backend mismatch");
    assert.equal(MediaJob.safeParse({ ...done, result: { ...result, size: "1536x1024" } }).success, false, "size mismatch");
    assert.equal(MediaJob.safeParse({ ...done, result: { ...result, prompt: "别的" } }).success, false, "prompt mismatch");
    assert.equal(MediaJob.safeParse({ ...done, remoteRunId: `run_${ID}` }).success, false, "remoteRunId only on codex");
    const codex = { ...route, backend: "codex", fallbackReason: null };
    assert.ok(MediaJob.safeParse({ ...done, route: codex, remoteRunId: `run_${ID}`, result: { ...result, backend: "codex", workflowHash: null } }).success);
    assert.equal(MediaJob.safeParse({ ...done, result: { ...result, seed: 2 ** 32 } }).success, false, "seed is 32-bit");
    assert.equal(
      MediaJob.safeParse({ ...done, route: { ...route, fallbackReason: "session_local_only" } }).success,
      false,
      "session_local_only is for immersive only",
    );
  });

  it("MediaJob: only immersive jobs carry intentHash and need the proposing agent", () => {
    const auto = { ...job, authorization: "immersive", intentHash: sha("d") };
    assert.ok(MediaJob.safeParse(auto).success);
    assert.equal(MediaJob.safeParse({ ...auto, intentHash: null }).success, false);
    assert.equal(MediaJob.safeParse({ ...auto, source: { ...job.source, agent: null } }).success, false);
    assert.equal(MediaJob.safeParse({ ...job, intentHash: sha("d") }).success, false, "user_tap has no intentHash");
    const topic = { kind: "topic", projectId: `proj_${ID}`, messageId: `msg_${ID}`, agent: "codex" };
    assert.equal(MediaJob.safeParse({ ...auto, source: topic }).success, false, "no immersive mode in topics");
    assert.ok(MediaJob.safeParse({ ...job, source: topic }).success, "tapping 画 in a topic is fine");
  });

  it("MediaJob: authorization must fit the job kind", () => {
    for (const a of ["user_play", "reply_as_voice"]) {
      assert.equal(MediaJob.safeParse({ ...job, authorization: a }).success, false, `draw cannot be ${a}`);
    }
    const speech = { ...job, kind: "speech", draw: null };
    for (const a of ["user_play", "reply_as_voice"]) assert.ok(MediaJob.safeParse({ ...speech, authorization: a }).success, a);
    assert.equal(MediaJob.safeParse({ ...speech, authorization: "user_tap" }).success, false, "speech is not user_tap");
  });

  it("DrawRequest: size whitelist, prompt length, strict", () => {
    assert.ok(DrawRequest.safeParse(draw).success);
    assert.equal(DrawRequest.safeParse({ ...draw, size: "8192x8192" }).success, false);
    assert.equal(DrawRequest.safeParse({ ...draw, prompt: "x".repeat(1001) }).success, false);
    assert.equal(DrawRequest.safeParse({ ...draw, prompt: "   " }).success, false);
    assert.equal(DrawRequest.safeParse({ ...draw, workflow: {} }).success, false);
  });

  it("StartRunRequest: kind image cannot carry attachments", () => {
    const base = {
      protocol: 1,
      runId: `run_${ID}`,
      profileId: "codex-image",
      snapshot: { id: `snap_${ID}`, content: "画", contentHash: sha("b") },
      limits: { idleTimeoutMs: 60_000, totalTimeoutMs: 600_000 },
    };
    assert.ok(StartRunRequest.safeParse({ ...base, kind: "image" }).success);
    assert.ok(StartRunRequest.safeParse(base).success);
    const att = [{ index: 1, mime: "image/png", bytes: 3, sha256: sha("a"), data: "AAAA" }];
    assert.equal(StartRunRequest.safeParse({ ...base, kind: "image", attachments: att }).success, false);
  });

  it("artifact rides on terminal(completed); quota shape; capabilities optional", () => {
    const artifact = { sha256: sha("a"), mime: "image/png", bytes: 1000 };
    const ev = { type: "terminal", seq: 3, ts: NOW, result: { outcome: "completed", exitCode: 0, artifact } };
    assert.ok(RemoteEvent.safeParse(ev).success);
    assert.ok(RemoteEvent.safeParse({ ...ev, result: { outcome: "completed", exitCode: 0 } }).success, "text Run unchanged");
    assert.equal(
      RemoteEvent.safeParse({ ...ev, result: { ...ev.result, artifact: { ...artifact, bytes: 11 * 1024 * 1024 } } }).success,
      false,
    );
    assert.ok(RemoteProfileQuota.safeParse({ fiveHour: { usedPercent: 22, windowMinutes: 300, resetsAt: null }, weekly: null, creditsInUse: null, readAt: NOW }).success);
    const health = { protocol: 1, nodeId: "n", profiles: [], activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 1, heartbeatMs: 1 };
    assert.ok(NodeHealth.safeParse({ ...health, capabilities: { imageRuns: true, imageProfiles: ["codex-image"], quota: true } }).success);
  });

  it("commands, queries and event are registered", () => {
    assert.ok(COMMANDS["draw.start"].request.safeParse({ type: "draw.start", request: draw, source: job.source }).success);
    assert.ok(COMMANDS["media.stop"].request.safeParse({ type: "media.stop", scope: { kind: "chat", conversationId: `conv_${ID}` } }).success);
    const swapped = { ...job.source, conversationId: `cmsg_${ID}`, messageId: `conv_${ID}` };
    assert.equal(MediaJob.safeParse({ ...job, source: swapped }).success, false, "chat ids use C-34's prefixes");
    assert.ok(ControlEvent.safeParse({ type: "media.updated", job }).success);
  });
});

describe("speech (C-42c)", () => {
  const clip = {
    id: `spch_${ID}`,
    textHash: sha("d"),
    voiceId: "whale-soft",
    speed: 1,
    engine: "cosyvoice",
    engineVersion: "2.0",
    audioRef: `aud_${ID}`,
    mime: "audio/ogg",
    durationMs: 3200,
    createdAt: NOW,
  };
  const speechJob = { ...job, kind: "speech", authorization: "user_play", draw: null };
  const ended = { state: "succeeded", startedAt: "2026-10-23T18:00:05+08:00", finishedAt: "2026-10-23T18:00:09+08:00" };

  it("speech job: succeeded needs a clip; no draw fields", () => {
    assert.ok(MediaJob.safeParse(speechJob).success);
    assert.equal(MediaJob.safeParse({ ...speechJob, ...ended }).success, false);
    assert.ok(MediaJob.safeParse({ ...speechJob, ...ended, speech: clip }).success);
    assert.equal(MediaJob.safeParse({ ...speechJob, ...ended, speech: clip, result }).success, false);
    assert.equal(MediaJob.safeParse({ ...done, speech: clip }).success, false);
  });

  it("SpeechClip records the speed it was synthesized at; voice option is strict", () => {
    const { speed: _s, ...noSpeed } = clip;
    assert.equal(SpeechClip.safeParse(noSpeed).success, false, "speed is part of the cache key");
    assert.equal(SpeechClip.safeParse({ ...clip, speed: 3 }).success, false);
    assert.equal(SpeechClip.safeParse({ ...clip, text: "原文" }).success, false, "strict");
    const opt = { id: "whale-soft", displayName: "小鲸鱼", engine: "indextts2", source: "preset", sampleRef: null };
    assert.ok(VoiceOption.safeParse(opt).success, "all three candidate engines stay readable");
    assert.equal(VoiceOption.safeParse({ ...opt, path: "C:/a.wav" }).success, false);
  });

  it("speech.play takes a source, never raw text; voice settings are strict", () => {
    const req = COMMANDS["speech.play"].request;
    assert.ok(req.safeParse({ type: "speech.play", source: job.source }).success);
    assert.equal(req.safeParse({ type: "speech.play", source: job.source, text: "随便念" }).success, true, "extra keys are stripped, not used");
    assert.equal("text" in (req.parse({ type: "speech.play", source: job.source, text: "x" }) as object), false);
    const upd = COMMANDS["agent.update"].request;
    assert.ok(upd.safeParse({ type: "agent.update", id: "claude", voice: { voiceId: "whale-soft", speed: 1 } }).success);
    assert.ok(upd.safeParse({ type: "agent.update", id: "claude", voice: null }).success);
    assert.equal(upd.safeParse({ type: "agent.update", id: "claude", voice: { voiceId: "whale-soft", speed: 5 } }).success, false);
    assert.equal(upd.safeParse({ type: "agent.update", id: "claude", voice: { voiceId: "x", speed: 1, refAudioPath: "C:/a.wav" } }).success, false);
  });
});

describe("media.list by message (C-42f)", () => {
  const q = QUERIES["media.list"].request;
  const scope = { kind: "chat", conversationId: `conv_${ID}` };
  const msg = (n: number) => `cmsg_01JAAAAAAAAAAAAAAAAAAAA${String(n).padStart(3, "0")}`;

  it("messageIds is optional, 1..MEDIA_LIST_MESSAGE_IDS_MAX, no duplicates", () => {
    assert.ok(q.safeParse({ type: "media.list", scope }).success);
    assert.ok(q.safeParse({ type: "media.list", scope, messageIds: [msg(1), msg(2)] }).success);
    const max = Array.from({ length: MEDIA_LIST_MESSAGE_IDS_MAX }, (_, i) => msg(i));
    assert.ok(q.safeParse({ type: "media.list", scope, messageIds: max }).success);
    assert.equal(q.safeParse({ type: "media.list", scope, messageIds: [...max, msg(999)] }).success, false);
    assert.equal(q.safeParse({ type: "media.list", scope, messageIds: [] }).success, false, "omit instead of empty");
    assert.equal(q.safeParse({ type: "media.list", scope, messageIds: [msg(1), msg(1)] }).success, false);
    assert.equal(q.safeParse({ type: "media.list", scope, messageIds: ["run_x"] }).success, false);
  });

  it("every asked message fits: ids × per-message cap ≤ the 200 response cap", () => {
    assert.ok(MEDIA_LIST_MESSAGE_IDS_MAX * MediaJobKind.options.length * MEDIA_LIST_PER_MESSAGE_KIND_MAX <= 200);
    assert.ok(QUERIES["media.list"].response.safeParse(Array(200).fill(job)).success);
    assert.equal(QUERIES["media.list"].response.safeParse(Array(201).fill(job)).success, false);
  });

  // 只看挑选用到的字段
  type J = { id: string; kind: "draw" | "speech"; state: MediaJobState; source: { kind: "chat"; conversationId: string; messageId: string; agent: null }; createdAt: string };
  let seq = 0;
  const mk = (messageId: string, kind: J["kind"], state: MediaJobState): J => {
    seq++;
    const n = String(seq).padStart(4, "0");
    return { id: `mjob_${n}`, kind, state, source: { kind: "chat", conversationId: `conv_${ID}`, messageId, agent: null }, createdAt: new Date(Date.UTC(2026, 9, 27) + seq * 1000).toISOString() };
  };

  it("a success older than the latest N failures / cancels is still returned (林离 #116)", () => {
    const m = msg(1);
    const ok = mk(m, "draw", "succeeded");
    const later = Array.from({ length: MEDIA_LIST_PER_MESSAGE_KIND_LATEST + 3 }, (_, i) => mk(m, "draw", i % 2 ? "failed" : "cancelled"));
    const picked = pickMessageMediaJobs([ok, ...later]);
    assert.ok(picked.includes(ok), "old success kept");
    assert.equal(picked.length, MEDIA_LIST_PER_MESSAGE_KIND_LATEST + 1);
    assert.deepEqual(picked.slice(0, MEDIA_LIST_PER_MESSAGE_KIND_LATEST), later.slice(-MEDIA_LIST_PER_MESSAGE_KIND_LATEST).reverse());
    assert.equal(picked.at(-1), ok, "newest first overall");
  });

  it("an old unfinished job is kept too; only the latest success / unfinished one is added", () => {
    const m = msg(2);
    const oldOk = mk(m, "draw", "succeeded");
    const ok = mk(m, "draw", "succeeded");
    const running = mk(m, "draw", "running");
    const later = Array.from({ length: 10 }, () => mk(m, "draw", "failed"));
    const picked = pickMessageMediaJobs([oldOk, ok, running, ...later]);
    assert.ok(picked.includes(ok) && picked.includes(running));
    assert.ok(!picked.includes(oldOk));
    assert.equal(picked.length, MEDIA_LIST_PER_MESSAGE_KIND_MAX);
  });

  it("caps per message and per kind; one kind or one message never pushes out another", () => {
    const ids = Array.from({ length: MEDIA_LIST_MESSAGE_IDS_MAX }, (_, i) => msg(100 + i));
    const jobs: J[] = [];
    for (const id of ids) {
      jobs.push(mk(id, "draw", "succeeded"), mk(id, "draw", "running"));
      for (let i = 0; i < 12; i++) jobs.push(mk(id, "draw", "failed"));
      jobs.push(mk(id, "speech", "succeeded"), mk(id, "speech", "running"));
      for (let i = 0; i < 30; i++) jobs.push(mk(id, "speech", "cancelled"));
    }
    const picked = pickMessageMediaJobs(jobs);
    assert.equal(picked.length, ids.length * MediaJobKind.options.length * MEDIA_LIST_PER_MESSAGE_KIND_MAX);
    assert.ok(picked.length <= 200);
    for (const id of ids)
      for (const kind of MediaJobKind.options) {
        const mine = picked.filter((j) => j.source.messageId === id && j.kind === kind);
        assert.ok(mine.some((j) => j.state === "succeeded") && mine.some((j) => j.state === "running"), `${id} ${kind}`);
      }
    for (let i = 1; i < picked.length; i++) assert.ok(picked[i - 1]!.createdAt >= picked[i]!.createdAt);
  });

  it("few jobs come back unchanged, newest first", () => {
    const a = mk(msg(3), "draw", "failed");
    const b = mk(msg(3), "speech", "succeeded");
    assert.deepEqual(pickMessageMediaJobs([a, b]), [b, a]);
    assert.deepEqual(pickMessageMediaJobs([]), []);
  });
});
