import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  COMMANDS,
  ControlEvent,
  DrawRequest,
  MEDIA_JOB_TRANSITIONS,
  MediaJob,
  MediaJobState,
  NodeHealth,
  RemoteEvent,
  RemoteProfileQuota,
  StartRunRequest,
  canTransition,
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
    assert.ok(ControlEvent.safeParse({ type: "media.updated", job }).success);
  });
});
