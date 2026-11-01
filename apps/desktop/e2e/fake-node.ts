import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { REMOTE_PROTOCOL_VERSION, StartRunRequest, type NodeHealth, type RemoteEvent } from "@room/schemas";

/**
 * X-21 的「假节点」：一个按 AgentServer 协议说话的本地 HTTP 服务。
 * 不启动任何 CLI，行为由测试脚本按 profile 指定：
 *   answer / hold（等 cancel）/ error / timeout / cancelled
 * 主控端用的是真的 HttpRemoteAgentAdapter，所以 HTTP、鉴权、NDJSON 流、cancel 都会被走到。
 */

export type NodeBehavior =
  | { kind: "answer"; text: string; deltas?: readonly string[] }
  | { kind: "hold"; deltas?: readonly string[] }
  | { kind: "error"; reason: "quota_exhausted" | "process_exit_nonzero" | "internal"; message?: string }
  | { kind: "timeout"; timeoutKind?: "idle" | "total" }
  | { kind: "cancelled"; reason?: string }
  /** X-31：不理 cancel，过 delayMs 照样答完（模拟撤回 / 取消瞬间刚好答完的迟到结果） */
  | { kind: "late"; text: string; delayMs: number };

export interface FakeNodeOptions {
  nodeId: string;
  profiles: readonly string[];
  token: string;
  /** 不传时模拟 1A 老节点；传入时 health 原样上报模型能力 */
  profileModels?: NodeHealth["profileModels"];
  /** X-34b：上报的可选能力（不传 = 老节点，什么都不报） */
  capabilities?: NodeHealth["capabilities"];
  /** 每个 profile 默认的行为；测试可以随时 setBehavior 覆盖 */
  behavior?: Record<string, NodeBehavior | readonly NodeBehavior[]>;
  heartbeatMs?: number;
  leaseMs?: number;
}

type SequencedEvent = Exclude<RemoteEvent, { type: "heartbeat" }>;
type EventPayload<Event = SequencedEvent> = Event extends SequencedEvent
  ? Omit<Event, "seq" | "ts"> & { ts?: string }
  : never;

interface RunState {
  runId: string;
  profileId: string;
  contentHash: string;
  events: SequencedEvent[];
  subscribers: Set<(e: RemoteEvent) => void>;
  finished: boolean;
  timer: NodeJS.Timeout | null;
  ignoreCancel?: boolean;
}

export interface RecordedStart {
  runId: string;
  profileId: string;
  contentHash: string;
  snapshotId: string;
  idleTimeoutMs: number;
  totalTimeoutMs: number;
  /** 保留字段是否存在的区别：老节点请求应省略它，不能是 null */
  model?: StartRunRequest["model"];
}

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export class FakeNode {
  readonly nodeId: string;
  readonly profiles: readonly string[];
  readonly token: string;
  readonly profileModels: NodeHealth["profileModels"];
  readonly capabilities: NodeHealth["capabilities"];
  readonly heartbeatMs: number;
  readonly leaseMs: number;
  readonly starts: RecordedStart[] = [];
  readonly requests: string[] = [];
  /** X-31：节点实际收到的完整 StartRun 请求体（看 Snapshot 原文里有没有撤回的内容） */
  readonly bodies: StartRunRequest[] = [];

  #server: Server | null = null;
  #port = 0;
  #runs = new Map<string, RunState>();
  #behaviors = new Map<string, NodeBehavior[]>();
  #heartbeat: NodeJS.Timeout | null = null;

  constructor(options: FakeNodeOptions) {
    this.nodeId = options.nodeId;
    this.profiles = options.profiles;
    this.token = options.token;
    this.profileModels = options.profileModels;
    this.capabilities = options.capabilities;
    this.heartbeatMs = options.heartbeatMs ?? 100;
    this.leaseMs = options.leaseMs ?? 1_000;
    for (const [profile, behavior] of Object.entries(options.behavior ?? {})) {
      this.#behaviors.set(profile, Array.isArray(behavior) ? [...behavior] : [behavior as NodeBehavior]);
    }
  }

  get url(): string {
    return "http://127.0.0.1:" + this.#port;
  }

  /** X-31：节点这边这个 Run 已经发出终止事件（不理 cancel 的 late 行为也算交卷） */
  isFinished(runId: string): boolean {
    return this.#runs.get(runId)?.finished === true;
  }

  /** 下一次（或接下来几次）这个 profile 的行为 */
  setBehavior(profile: string, behavior: NodeBehavior | readonly NodeBehavior[]): void {
    this.#behaviors.set(profile, Array.isArray(behavior) ? [...behavior] : [behavior as NodeBehavior]);
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    this.#server = createServer((req, res) => {
      this.#handle(req, res).catch((error: unknown) => {
        if (!res.headersSent) this.#json(res, 500, { error: "internal", message: String(error) });
        else res.end();
      });
    });
    await new Promise<void>((resolve) => this.#server!.listen(0, "127.0.0.1", resolve));
    this.#port = (this.#server.address() as { port: number }).port;
    this.#heartbeat = setInterval(() => {
      for (const run of this.#runs.values()) {
        if (!run.finished) {
          // heartbeat 没有 seq，不写入可重放的事件序列。
          for (const sub of run.subscribers) sub({ type: "heartbeat", ts: new Date().toISOString(), lastSeq: run.events.length - 1 });
        }
      }
    }, this.heartbeatMs);
    this.#heartbeat.unref();
  }

  async stop(): Promise<void> {
    if (this.#heartbeat !== null) clearInterval(this.#heartbeat);
    for (const run of this.#runs.values()) if (run.timer !== null) clearTimeout(run.timer);
    for (const run of this.#runs.values()) {
      run.finished = true;
      for (const sub of run.subscribers) sub({ type: "heartbeat", ts: new Date().toISOString(), lastSeq: run.events.length - 1 });
    }
    const server = this.#server;
    this.#server = null;
    if (server !== null) {
      // 事件流是长连接：先断开所有 socket，否则 close() 会一直等
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        setTimeout(resolve, 300).unref();
      });
    }
  }

  #emit(run: RunState, event: EventPayload): void {
    if (run.finished) return;
    const full = { ...event, seq: run.events.length, ts: event.ts ?? new Date().toISOString() } as SequencedEvent;
    run.events.push(full);
    for (const sub of run.subscribers) sub(full);
    if (full.type === "terminal") run.finished = true;
  }

  #finish(run: RunState, result: Extract<RemoteEvent, { type: "terminal" }>["result"], delayMs = 0): void {
    if (run.finished) return;
    run.timer = setTimeout(() => {
      this.#emit(run, { type: "terminal", result });
    }, delayMs);
  }

  #schedule(run: RunState, behavior: NodeBehavior): void {
    this.#emit(run, { type: "started" });
    const deltas = "deltas" in behavior ? behavior.deltas ?? [] : [];
    let seq = 0;
    const pushDelta = () => {
      const text = deltas[seq];
      if (text === undefined) return true;
      this.#emit(run, { type: "text_delta", text });
      seq += 1;
      return false;
    };
    const pump = () => {
      if (run.finished) return;
      if (!pushDelta()) { run.timer = setTimeout(pump, 10); return; }
      if (behavior.kind === "answer") {
        this.#emit(run, { type: "message_complete", text: behavior.text });
        this.#finish(run, { outcome: "completed", exitCode: 0 }, 5);
      } else if (behavior.kind === "error") {
        this.#finish(run, { outcome: "error", reason: behavior.reason, exitCode: 1, message: behavior.message ?? "fake error" }, 5);
      } else if (behavior.kind === "timeout") {
        this.#finish(run, { outcome: "timed_out", kind: behavior.timeoutKind ?? "idle" }, 20);
      } else if (behavior.kind === "cancelled") {
        this.#finish(run, { outcome: "cancelled", reason: behavior.reason ?? "fake cancelled" }, 5);
      } else if (behavior.kind === "late") {
        run.ignoreCancel = true;
        run.timer = setTimeout(() => {
          this.#emit(run, { type: "message_complete", text: behavior.text });
          this.#emit(run, { type: "terminal", result: { outcome: "completed", exitCode: 0 } });
        }, behavior.delayMs);
      }
      // hold：什么都不做，等 cancel / stop
    };
    run.timer = setTimeout(pump, 5);
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.requests.push(req.method + " " + (req.url ?? ""));
    if (!this.#authenticated(req)) {
      this.#json(res, 401, { error: "unauthorized", message: "invalid or missing token" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://node");
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "v1") { this.#json(res, 404, { error: "not_found", message: "unknown path" }); return; }

    if (req.method === "GET" && parts[1] === "health" && parts.length === 2) {
      this.#json(res, 200, {
        protocol: REMOTE_PROTOCOL_VERSION,
        nodeId: this.nodeId,
        profiles: [...this.profiles],
        activeRuns: [...this.#runs.values()].filter((r) => !r.finished).length,
        maxConcurrentRuns: 4,
        leaseMs: this.leaseMs,
        heartbeatMs: this.heartbeatMs,
        ...(this.profileModels === undefined ? {} : { profileModels: this.profileModels }),
        ...(this.capabilities === undefined ? {} : { capabilities: this.capabilities }),
      });
      return;
    }
    if (req.method === "GET" && parts[1] === "runs" && parts.length === 2) {
      this.#json(res, 200, [...this.#runs.values()].map((r) => ({
        runId: r.runId,
        profileId: r.profileId,
        state: r.finished ? "finished" : "running",
        lastSeq: r.events.length - 1,
        subscribers: r.subscribers.size,
      })));
      return;
    }
    if (req.method === "POST" && parts[1] === "runs" && parts.length === 2) {
      const parsed = StartRunRequest.safeParse(await this.#readJson(req));
      if (!parsed.success) { this.#json(res, 400, { error: "bad_request", message: "invalid fields" }); return; }
      const body = parsed.data;
      if (sha(body.snapshot.content) !== body.snapshot.contentHash) {
        this.#json(res, 422, { error: "hash_mismatch", message: "snapshot content does not match contentHash" });
        return;
      }
      if (this.#runs.has(body.runId)) {
        this.#json(res, 200, { runId: body.runId, status: "already_exists", eventsPath: "/v1/runs/" + body.runId + "/events" });
        return;
      }
      if (!this.profiles.includes(body.profileId)) {
        this.#json(res, 400, { error: "unknown_profile", message: "unknown profileId" });
        return;
      }
      const run: RunState = {
        runId: body.runId,
        profileId: body.profileId,
        contentHash: body.snapshot.contentHash,
        events: [],
        subscribers: new Set(),
        finished: false,
        timer: null,
      };
      this.#runs.set(body.runId, run);
      this.bodies.push(body);
      this.starts.push({
        runId: body.runId,
        profileId: body.profileId,
        contentHash: body.snapshot.contentHash,
        snapshotId: body.snapshot.id,
        idleTimeoutMs: body.limits.idleTimeoutMs,
        totalTimeoutMs: body.limits.totalTimeoutMs,
        ...(body.model === undefined ? {} : { model: body.model }),
      });
      const queue = this.#behaviors.get(body.profileId) ?? [];
      const behavior = queue.shift() ?? { kind: "answer", text: "默认回答" };
      this.#schedule(run, behavior);
      this.#json(res, 202, { runId: body.runId, status: "accepted", eventsPath: "/v1/runs/" + body.runId + "/events" });
      return;
    }

    const runId = parts[2];
    const run = runId === undefined ? undefined : this.#runs.get(runId);
    if (run === undefined) { this.#json(res, 404, { error: "not_found", message: "unknown run" }); return; }

    if (req.method === "GET" && parts.length === 4 && parts[3] === "events") {
      const after = Number(url.searchParams.get("after") ?? "-1");
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      res.flushHeaders();
      const write = (event: RemoteEvent) => {
        if (res.writableEnded) return;
        res.write(JSON.stringify(event) + "\n");
        if (event.type === "terminal") { sub(); res.end(); }
      };
      const sub = () => { run.subscribers.delete(write); };
      for (const event of run.events) if (event.seq > after) write(event);
      if (run.finished) { res.end(); return; }
      run.subscribers.add(write);
      req.on("close", sub);
      return;
    }

    if (req.method === "POST" && parts.length === 4 && parts[3] === "cancel") {
      if (!run.finished && run.ignoreCancel !== true) this.#finish(run, { outcome: "cancelled", reason: "cancelled by controller" }, 2);
      this.#json(res, 202, { ok: true });
      return;
    }

    this.#json(res, 404, { error: "not_found", message: "unknown path" });
  }

  #authenticated(req: IncomingMessage): boolean {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (match === null || match[1] === undefined) return false;
    const a = createHash("sha256").update(match[1], "utf8").digest();
    const b = createHash("sha256").update(this.token, "utf8").digest();
    return timingSafeEqual(a, b);
  }

  async #readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (chunks.length === 0) return {};
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
  }

  #json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
    res.end(text);
  }
}
