import { createHash, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { promisify } from "node:util";
import {
  CancelRunRequest,
  NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS,
  REMOTE_PROTOCOL_VERSION,
  StartRunAttachments,
  attachmentManifestBlock,
  imageBlockPlaced,
  imageSlotNonce,
  StartRunRequest,
  type NodeHealth,
  type RemoteErrorCode,
  type RemoteProfileQuota,
  type RemoteEvent,
  type RemoteRunSummary,
  type StartRunResponse,
} from "@room/schemas";
import type { Profile, ServerConfig } from "./config";
import { RemoteRun, chatKeyOf } from "./remote-run";
import { MemorySlotError, preparePrompt, selectForProfile } from "./chat-memory";
import { checkModel } from "./model-args";
import { attachmentProblem, profileMaySeeImages, visionOf } from "./images";
import { sweepStaleRunDirs } from "./image-artifact";
import { claudeAccountOf, createClaudeQuotaStore, createQuotaReader, readCodexQuota, readDeepSeekBalance } from "./quota";

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

export function createAgentServer(
  cfg: ServerConfig,
  token: string,
  /** 测试可替换读额度的方式；默认起 codex app-server */
  quotaRead?: (profileId: string, profile: Profile) => Promise<RemoteProfileQuota>,
): AgentServer {
  const runs = new Map<string, RemoteRun>();
  const tokenDigest = sha256Buf(token);

  // S-21：Claude 的额度从 Run 的输出里记（rate_limit_event），读的时候直接给最近一次
  const claudeQuota = createClaudeQuotaStore();
  const readQuota = createQuotaReader(
    quotaRead ??
      ((_id, p) =>
        p.quota?.source === "claude-stream"
          ? Promise.resolve(claudeQuota.read(p.quota.account))
          : p.quota?.source === "deepseek-balance"
            ? readDeepSeekBalance(p)
            : readCodexQuota(p)),
  );
  const activeCount = () => [...runs.values()].filter((r) => !r.isFinished).length;
  const imageProfiles = Object.entries(cfg.profiles)
    .filter(([, p]) => p.imageRun)
    .map(([id]) => id);
  // 上次节点崩在清理之前留下的画图 Run 目录：启动时清掉
  for (const root of new Set(Object.values(cfg.profiles).flatMap((p) => (p.imageRun ? [p.imageRun.outputDir] : [])))) {
    const removed = sweepStaleRunDirs(root);
    if (removed.length > 0) console.log(`[agent-server] removed ${removed.length} leftover image run folder(s) in ${root}`);
  }

  const memoryHealth = createMemoryHealth(cfg);

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
        profileModels: Object.entries(cfg.profiles).map(([profileId, p]) => ({
          profileId,
          models: p.models,
          ...(p.models.length === 0 && p.fixedModelVision !== undefined ? { fixedModelVision: p.fixedModelVision } : {}),
        })),
        // S-20：配了记忆、现在按规则读得到的聊天 profile（不合格的不报，界面显示「此记忆来源不可用」）
        memoryProfiles: memoryHealth.available(),
        // S-23：能收图 = 请求体够大并且至少一个 profile 配了交图方式、有模型实测能看
        capabilities: {
          attachments: cfg.maxBodyBytes >= NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS && Object.values(cfg.profiles).some(profileMaySeeImages),
          imageRuns: imageProfiles.length > 0,
          ...(imageProfiles.length > 0 ? { imageProfiles } : {}),
          quota: Object.values(cfg.profiles).some((p) => p.quota),
        },
      };
      return sendJson(res, 200, body);
    }

    // GET /v1/profiles/:profileId/quota（契约 C-42b，S-24）：读不到时各项为 null，仍是 200
    if (req.method === "GET" && parts.length === 4 && parts[1] === "profiles" && parts[3] === "quota") {
      const profileId = parts[2]!;
      const profile = Object.hasOwn(cfg.profiles, profileId) ? cfg.profiles[profileId] : undefined;
      if (!profile) throw new HttpError(404, "unknown_profile", "unknown profile");
      if (!profile.quota) throw new HttpError(404, "not_found", "this profile has no quota source");
      const q = await readQuota(profileId, profile);
      // 额度是实时值，不让中间缓存 / Electron 的 HTTP 缓存留旧数字（汐 #133）
      res.setHeader("cache-control", "no-store");
      return sendJson(res, 200, q);
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

    // GET /v1/runs/:id/artifacts/:sha256（契约 C-42b）：取回 image Run 画好的图，取完就丢
    if (req.method === "GET" && parts.length === 5 && parts[3] === "artifacts") {
      const held = run.artifact;
      if (!held || held.meta.sha256 !== parts[4]) throw new HttpError(404, "not_found", "no such artifact");
      res.writeHead(200, {
        "content-type": held.meta.mime,
        "content-length": String(held.bytes.length),
        "cache-control": "no-store",
      });
      // 「写完」不等于主控端收到了：取过之后再留 leaseMs，给断线重取一次机会（汐 #131），之后丢掉
      res.on("finish", () => run.artifactFetched());
      res.end(held.bytes);
      return;
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
      // C-42a：清单块对不上这组附件按 hash_mismatch 报（契约），其余字段问题是 bad_request
      if (manifestMismatch(raw)) {
        throw new HttpError(422, "hash_mismatch", "attachments do not match the manifest block at the start of content");
      }
      // 只返回字段路径，不回显内容
      const paths = parsed.error.issues.map((i) => i.path.join(".") || "(root)");
      throw new HttpError(400, "bad_request", `invalid fields: ${[...new Set(paths)].join(", ")}`);
    }
    const reqBody = parsed.data;
    // schema 已经核过图片资料块；这里再核一次，让交图前的构造不会因为它抛异常（汐 #131）
    if (reqBody.attachments && (!reqBody.imageSlot || !imageBlockPlaced(reqBody.snapshot.content, reqBody.attachments, reqBody.imageSlot))) {
      throw new HttpError(400, "bad_request", "invalid fields: imageSlot");
    }

    // 幂等：同一个 runId 重复提交
    const existing = runs.get(reqBody.runId);
    if (existing) {
      if (
        existing.profileId === reqBody.profileId &&
        existing.contentHash === reqBody.snapshot.contentHash &&
        sameModel(existing.model, reqBody.model) &&
        existing.kind === (reqBody.kind ?? "text") &&
        existing.chatKey === chatKeyOf(reqBody.chat) &&
        sameList(existing.attachmentShas, (reqBody.attachments ?? []).map((a) => a.sha256))
      ) {
        return sendJson(res, 200, startResponse(reqBody.runId, "already_exists"));
      }
      throw new HttpError(409, "run_id_conflict", "runId already used with a different payload");
    }

    // 只认配置里自己写的 profile：不让 "constructor" / "__proto__" 这类名字取到对象原型上的东西
    const profile = Object.hasOwn(cfg.profiles, reqBody.profileId) ? cfg.profiles[reqBody.profileId] : undefined;
    if (!profile) throw new HttpError(400, "unknown_profile", "unknown profileId");

    if (reqBody.model) {
      const problem = checkModel(profile, reqBody.model);
      if (problem) throw new HttpError(400, "unknown_model", problem);
    }

    // C-42b：画图 profile 只接 image Run，别的 profile 不接 image Run
    const kind = reqBody.kind ?? "text";
    if ((kind === "image") !== (profile.imageRun !== undefined)) {
      throw new HttpError(400, "unsupported_kind", `profile does not accept ${kind} runs`);
    }

    // C-42a：带图时这一次用的模型必须实测能看，并且 profile 配了交图方式；不满足整个拒绝，不丢图继续跑
    if (reqBody.attachments) {
      const vision = visionOf(profile, reqBody.model);
      if (vision !== "yes" || !profile.images) {
        throw new HttpError(400, "vision_unsupported", `the model for this run reports vision: ${vision}`);
      }
    }

    const actual = createHash("sha256").update(reqBody.snapshot.content, "utf8").digest("hex");
    if (actual !== reqBody.snapshot.contentHash) {
      throw new HttpError(422, "hash_mismatch", "snapshot content does not match contentHash");
    }
    if (reqBody.attachments) {
      const problem = attachmentProblem(reqBody.attachments);
      if (problem) throw new HttpError(422, "hash_mismatch", problem);
    }

    if (profile.verifyCommit && reqBody.snapshot.commitSha) {
      await verifyCommit(profile, reqBody.snapshot.commitSha);
    }

    if (activeCount() >= cfg.maxConcurrentRuns) {
      throw new HttpError(429, "node_busy", "node is at maxConcurrentRuns");
    }
    // 画图一个 profile 同时只跑一张（ADR-004 §3：Codex 一次一张）。图的归属靠每个 Run 自己的目录，不靠这条限制
    if (kind === "image" && [...runs.values()].some((r) => !r.isFinished && r.profileId === reqBody.profileId)) {
      throw new HttpError(429, "node_busy", "this image profile is already drawing");
    }

    // S-20：聊天 Run 在这里读记忆、换槽位（读不到也不失败，槽位里换成「不可用」）。日志只写原因，不写正文
    const otherNonces = reqBody.imageSlot ? [imageSlotNonce(reqBody.imageSlot) ?? ""].filter(Boolean) : [];
    let prepared: ReturnType<typeof preparePrompt>;
    try {
      prepared = preparePrompt(cfg, profile, reqBody.snapshot.content, reqBody.chat, otherNonces, (line) =>
        console.warn(`[agent-server] run ${reqBody.runId}：${line}`),
      );
    } catch (err) {
      if (err instanceof MemorySlotError) throw new HttpError(400, "bad_request", "invalid fields: chat.memory.marker");
      throw err;
    }
    if (profile.memory && reqBody.chat?.memory) memoryHealth.record(reqBody.profileId, prepared.promptFinal?.memory?.status);
    const account = claudeAccountOf(profile);
    const run = new RemoteRun(
      reqBody,
      profile,
      cfg,
      (r) => {
        console.log(`[agent-server] run ${r.runId} finished`);
      },
      prepared,
      account === null ? undefined : (info) => claudeQuota.record(account, info),
    );
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
      // terminal(node_shutdown) 要等子进程真的退出才产出（最晚 killGraceMs + 5 秒的兜底）。
      // 先等它写给订阅方、事件流自己结束，再断连接；不然主控端只看到断线，要等租约才知道节点关了（C-49 / A-01）
      const deadline = Date.now() + cfg.killGraceMs + 6_000;
      while (activeCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
      // 给刚写出去的 terminal 一点时间落到 socket 上
      await new Promise((r) => setTimeout(r, 50));
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

/**
 * 契约 C-42a：附件本身合法、content 却不以这组附件的清单块开头 → hash_mismatch（不是 bad_request）。
 * 直接按原始请求重算，不依赖 schema 里 refine 的提示文字（汐 #131）
 */
function manifestMismatch(raw: unknown): boolean {
  if (typeof raw !== "object" || raw === null) return false;
  const r = raw as { attachments?: unknown; snapshot?: { content?: unknown } };
  const atts = StartRunAttachments.safeParse(r.attachments);
  const content = r.snapshot?.content;
  return atts.success && typeof content === "string" && !content.startsWith(attachmentManifestBlock(atts.data));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function startResponse(runId: StartRunResponse["runId"], status: StartRunResponse["status"]): StartRunResponse {
  return { runId, status, eventsPath: `/v1/runs/${runId}/events` };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

/** 启动时按规则检查一遍记忆（ADR-003 §2a）；之后每次聊天 Run 读的结果和 health 都会刷新，health 最多一分钟重读一次 */
export const MEMORY_HEALTH_TTL_MS = 60_000;

function createMemoryHealth(cfg: ServerConfig, now: () => number = Date.now) {
  const state = new Map<string, { ok: boolean; at: number }>();
  const ids = Object.entries(cfg.profiles)
    .filter(([, p]) => p.memory)
    .map(([id]) => id);
  const check = (id: string) => {
    const ok = selectForProfile(cfg, cfg.profiles[id]!).status !== "unavailable";
    state.set(id, { ok, at: now() });
  };
  for (const id of ids) check(id);
  return {
    available(): string[] {
      for (const id of ids) {
        const s = state.get(id);
        if (!s || now() - s.at > MEMORY_HEALTH_TTL_MS) check(id);
      }
      return ids.filter((id) => state.get(id)?.ok);
    },
    record(id: string, status: string | undefined): void {
      if (ids.includes(id) && status !== undefined) state.set(id, { ok: status !== "unavailable", at: now() });
    },
  };
}

function sha256Buf(s: string): Buffer {
  return createHash("sha256").update(s, "utf8").digest();
}
