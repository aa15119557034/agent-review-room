import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import {
  CancelRunRequest,
  REMOTE_PROTOCOL_VERSION,
  StartRunRequest,
  type NodeHealth,
  type RemoteErrorCode,
  type RemoteEvent,
  type RemoteRunSummary,
  type StartRunResponse,
} from "@room/schemas";
import type { Profile, ServerConfig } from "./config";
import { RemoteRun } from "./remote-run";
import { checkModel } from "./model-args";

const execFileP = promisify(execFile);

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: RemoteErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export interface AgentServer {
  server: Server;
  /** 终止所有 run 并关闭监听 */
  close(): Promise<void>;
}

export function createAgentServer(cfg: ServerConfig, token: string): AgentServer {
  const runs = new Map<string, RemoteRun>();
  const tokenDigest = sha256Buf(token);

  const activeCount = () => [...runs.values()].filter((r) => !r.isFinished).length;

  // 定期清理结束超过 TTL 的 run
  const gc = setInterval(() => {
    const now = Date.now();
    for (const [id, r] of runs) {
      if (r.finishedAtMs !== undefined && now - r.finishedAtMs > cfg.finishedRunTtlMs) runs.delete(id);
    }
  }, 30_000);
  gc.unref();

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const e = err instanceof HttpError ? err : new HttpError(500, "internal", "internal error");
      if (!(err instanceof HttpError)) console.error("[agent-server] unhandled", err);
      if (!res.headersSent) sendJson(res, e.status, { error: e.code, message: e.message });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    authenticate(req);

    const url = new URL(req.url ?? "/", "http://node");
    const parts = url.pathname.split("/").filter(Boolean); // ["v1", "runs", id, ...]
    if (parts[0] !== "v1") throw new HttpError(404, "not_found", "unknown path");

    // GET /v1/health
    if (req.method === "GET" && parts.length === 2 && parts[1] === "health") {
      const body: NodeHealth = {
        protocol: REMOTE_PROTOCOL_VERSION,
        nodeId: cfg.nodeId,
        profiles: Object.keys(cfg.profiles),
        activeRuns: activeCount(),
        maxConcurrentRuns: cfg.maxConcurrentRuns,
        leaseMs: cfg.leaseMs,
        heartbeatMs: cfg.heartbeatMs,
        // S-22：每个 profile 都报，models 为空 = 模型写死在节点配置里
        profileModels: Object.entries(cfg.profiles).map(([profileId, p]) => ({ profileId, models: p.models })),
      };
      return sendJson(res, 200, body);
    }

    if (parts[1] !== "runs") throw new HttpError(404, "not_found", "unknown path");

    // GET /v1/runs
    if (req.method === "GET" && parts.length === 2) {
      const list: RemoteRunSummary[] = [...runs.values()].map((r) => ({
        runId: r.runId as RemoteRunSummary["runId"],
        profileId: r.profileId,
        state: r.isFinished ? "finished" : "running",
        lastSeq: r.lastSeq,
        subscribers: r.subscriberCount,
      }));
      return sendJson(res, 200, list);
    }

    // POST /v1/runs
    if (req.method === "POST" && parts.length === 2) {
      return startRun(await readJson(req), res);
    }

    const runId = parts[2];
    const run = runId ? runs.get(runId) : undefined;
    if (!run) throw new HttpError(404, "not_found", "unknown run");

    // GET /v1/runs/:id/events?after=N
    if (req.method === "GET" && parts.length === 4 && parts[3] === "events") {
      const after = Number(url.searchParams.get("after") ?? "-1");
      if (!Number.isInteger(after) || after < -1) throw new HttpError(400, "bad_request", "invalid after");
      return streamEvents(run, after, req, res);
    }

    // POST /v1/runs/:id/cancel
    if (req.method === "POST" && parts.length === 4 && parts[3] === "cancel") {
      const body = CancelRunRequest.safeParse(await readJson(req));
      if (!body.success) throw new HttpError(400, "bad_request", "invalid cancel body");
      run.cancel(body.data.reason);
      return sendJson(res, 202, { ok: true });
    }

    // POST /v1/runs/:id/permissions/:requestId — Phase 1
    if (req.method === "POST" && parts.length === 5 && parts[3] === "permissions") {
      throw new HttpError(501, "not_implemented", "permission relay is not implemented in the Phase 0 skeleton");
    }

    throw new HttpError(404, "not_found", "unknown path");
  }

  async function startRun(raw: unknown, res: ServerResponse): Promise<void> {
    const parsed = StartRunRequest.safeParse(raw);
    if (!parsed.success) {
      // 只返回字段路径，不回显内容
      const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)");
      throw new HttpError(400, "bad_request", `invalid fields: ${[...new Set(paths)].join(", ")}`);
    }
    const reqBody = parsed.data;

    // 幂等：同一个 runId 重复提交
    const existing = runs.get(reqBody.runId);
    if (existing) {
      if (
        existing.profileId === reqBody.profileId &&
        existing.contentHash === reqBody.snapshot.contentHash &&
        sameModel(existing.model, reqBody.model)
      ) {
        return sendJson(res, 200, startResponse(reqBody.runId, "already_exists"));
      }
      throw new HttpError(409, "run_id_conflict", "runId already used with a different payload");
    }

    const profile = cfg.profiles[reqBody.profileId];
    if (!profile) throw new HttpError(400, "unknown_profile", "unknown profileId");

    if (reqBody.model) {
      const problem = checkModel(profile, reqBody.model);
      if (problem) throw new HttpError(400, "unknown_model", problem);
    }

    const actual = createHash("sha256").update(reqBody.snapshot.content, "utf8").digest("hex");
    if (actual !== reqBody.snapshot.contentHash) {
      throw new HttpError(422, "hash_mismatch", "snapshot content does not match contentHash");
    }

    if (profile.verifyCommit && reqBody.snapshot.commitSha) {
      await verifyCommit(profile, reqBody.snapshot.commitSha);
    }

    if (activeCount() >= cfg.maxConcurrentRuns) {
      throw new HttpError(429, "node_busy", "node is at maxConcurrentRuns");
    }

    const run = new RemoteRun(reqBody, profile, cfg, (r) => {
      console.log(`[agent-server] run ${r.runId} finished`);
    });
    runs.set(run.runId, run);
    run.start();
    console.log(`[agent-server] run ${run.runId} started (profile=${run.profileId})`);
    return sendJson(res, 202, startResponse(reqBody.runId, "accepted"));
  }

  function streamEvents(run: RemoteRun, after: number, req: IncomingMessage, res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
    });
    res.flushHeaders();

    const write = (e: RemoteEvent) => {
      res.write(JSON.stringify(e) + "\n");
      if (e.type === "terminal") {
        cleanup();
        res.end();
      }
    };

    const heartbeat = setInterval(() => write(run.heartbeat()), cfg.heartbeatMs);
    let unsubscribe: () => void = () => {};
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe();
    };

    req.on("close", cleanup);
    unsubscribe = run.subscribe(after, write);
    // 如果补发过程中已经写出了 terminal，cleanup 已执行；这里再保险一次
    if (run.isFinished && !closed) {
      cleanup();
      res.end();
    }
  }

  function authenticate(req: IncomingMessage): void {
    const header = req.headers.authorization ?? "";
    const m = /^Bearer (.+)$/.exec(header);
    // 比较 sha256 摘要：长度固定，timingSafeEqual 不会因长度不同而提前返回
    if (!m?.[1] || !timingSafeEqual(sha256Buf(m[1]), tokenDigest)) {
      throw new HttpError(401, "unauthorized", "invalid or missing token");
    }
  }

  async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > cfg.maxBodyBytes) throw new HttpError(413, "payload_too_large", "body too large");
      chunks.push(chunk as Buffer);
    }
    if (size === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new HttpError(400, "bad_request", "body is not valid JSON");
    }
  }

  return {
    server,
    async close() {
      clearInterval(gc);
      for (const r of runs.values()) if (!r.isFinished) r.shutdown();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function verifyCommit(profile: Profile, expected: string): Promise<void> {
  try {
    const head = (await execFileP("git", ["rev-parse", "HEAD"], { cwd: profile.cwd })).stdout.trim();
    const dirty = (await execFileP("git", ["status", "--porcelain"], { cwd: profile.cwd })).stdout.trim();
    if (head !== expected) throw new HttpError(409, "commit_mismatch", `HEAD is ${head}, expected ${expected}`);
    if (dirty) throw new HttpError(409, "commit_mismatch", "working tree has uncommitted changes");
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(409, "commit_mismatch", "could not verify commit in profile cwd");
  }
}

function sameModel(a: StartRunRequest["model"], b: StartRunRequest["model"]): boolean {
  return a?.model === b?.model && a?.effort === b?.effort;
}

function startResponse(runId: StartRunResponse["runId"], status: StartRunResponse["status"]): StartRunResponse {
  return { runId, status, eventsPath: `/v1/runs/${runId}/events` };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sha256Buf(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}
