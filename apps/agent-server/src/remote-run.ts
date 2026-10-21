import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RemoteEvent, RemoteTerminal, StartRunRequest } from "@room/schemas";
import type { Profile, ServerConfig } from "./config";
import { killTree, spawnDetached } from "./process-tree";
import { createParser, type OutputParser, type ParserOutput } from "./parsers";
import { planSpawn } from "./win-command";

type SeqEvent = Exclude<RemoteEvent, { type: "heartbeat" }>;
type Subscriber = (event: RemoteEvent) => void;

/**
 * 节点上的一次执行。
 *
 * 不变量：恰好产出一个 terminal 事件。所有终止路径（正常退出、非零退出、启动失败、
 * 取消、超时、租约过期、输出超限、节点关闭）都经过 finish() 的单次守卫。
 */
export class RemoteRun {
  readonly runId: string;
  readonly profileId: string;
  readonly contentHash: string;

  private readonly events: SeqEvent[] = [];
  private readonly subscribers = new Set<Subscriber>();
  private child: ChildProcess | undefined;
  private terminal: RemoteTerminal | undefined;
  /** 已决定要杀进程时记下原因；进程真正退出后再产出对应的 terminal */
  private pendingOutcome: RemoteTerminal | undefined;
  private outputBytes = 0;
  /** profile.parser 不是 raw 时使用 */
  private readonly parser: OutputParser | null;
  private seq = 0;

  private idleTimer: NodeJS.Timeout | undefined;
  private totalTimer: NodeJS.Timeout | undefined;
  private leaseTimer: NodeJS.Timeout | undefined;
  private finishedAt: number | undefined;

  constructor(
    req: StartRunRequest,
    private readonly profile: Profile,
    private readonly cfg: ServerConfig,
    private readonly onFinished: (run: RemoteRun) => void,
  ) {
    this.runId = req.runId;
    this.profileId = req.profileId;
    this.contentHash = req.snapshot.contentHash;
    this.limits = {
      idleTimeoutMs: Math.min(req.limits.idleTimeoutMs, profile.maxIdleTimeoutMs),
      totalTimeoutMs: Math.min(req.limits.totalTimeoutMs, profile.maxTotalTimeoutMs),
    };
    this.input = req.snapshot.content;
    this.parser = createParser(profile.parser);
  }

  private readonly limits: { idleTimeoutMs: number; totalTimeoutMs: number };
  private readonly input: string;

  get isFinished(): boolean {
    return this.terminal !== undefined;
  }
  get lastSeq(): number {
    return this.seq - 1;
  }
  get subscriberCount(): number {
    return this.subscribers.size;
  }
  get finishedAtMs(): number | undefined {
    return this.finishedAt;
  }

  start(): void {
    // 订阅者必须在 leaseMs 内连上事件流，否则视为 Orchestrator 已经不在了
    this.armLease();
    this.totalTimer = setTimeout(
      () => this.stop({ outcome: "timed_out", kind: "total" }),
      this.limits.totalTimeoutMs,
    );
    this.resetIdle();

    let child: ChildProcess;
    try {
      // Windows 上 .cmd / .bat 会被包装成 cmd.exe /d /s /c "…"，见 win-command.ts
      const plan = planSpawn(this.profile.command, this.profile.args);
      child = spawn(plan.file, plan.args, {
        cwd: this.profile.cwd,
        env: buildEnv(this.profile),
        stdio: ["pipe", "pipe", "pipe"],
        detached: spawnDetached,
        windowsHide: true,
        windowsVerbatimArguments: plan.viaCmd,
        shell: false,
      });
    } catch (err) {
      this.finish({ outcome: "error", reason: "spawn_failed", exitCode: null, message: String(err) });
      return;
    }
    this.child = child;

    child.once("spawn", () => this.push({ type: "started", seq: 0, ts: "" }));
    child.once("error", (err) => {
      // spawn 失败（ENOENT 等）时不会有 close 事件
      if (child.pid === undefined) {
        this.finish({ outcome: "error", reason: "spawn_failed", exitCode: null, message: err.message });
      }
    });

    this.pipeOutput(child, "stdout");
    this.pipeOutput(child, "stderr");

    // stdin：原样写入 prompt。CLI 提前退出会触发 EPIPE，忽略即可，结果以退出码为准
    child.stdin?.on("error", () => {});
    child.stdin?.end(this.input, "utf8");

    // 用 close 而不是 exit：保证 stdout/stderr 全部读完后才产出 terminal
    child.once("close", (code) => {
      if (this.pendingOutcome) {
        this.finish(this.pendingOutcome);
        return;
      }
      if (!this.parser) {
        if (code !== 0) this.finish({ outcome: "error", reason: "process_exit_nonzero", exitCode: code });
        else this.finish({ outcome: "completed", exitCode: 0 });
        return;
      }
      // 有解析器：退出码 0 还不够，必须看到完整的结束标记。
      // 退出码非 0 时也先问解析器：CLI 因为额度用尽退出时，原因只写在结构化输出里（C-25）
      const { trailing, verdict } = this.parser.finish();
      this.emitParsed(trailing);
      if (!verdict.ok && verdict.reason === "quota_exhausted") {
        this.finish({ outcome: "error", reason: "quota_exhausted", exitCode: code, message: verdict.message });
      } else if (code !== 0) {
        this.finish({
          outcome: "error",
          reason: "process_exit_nonzero",
          exitCode: code,
          ...(verdict.ok ? {} : { message: verdict.message }),
        });
      } else if (verdict.ok) {
        this.push({ type: "message_complete", seq: 0, ts: "", text: verdict.finalText });
        this.finish({ outcome: "completed", exitCode: 0 });
      } else {
        this.finish({ outcome: "error", reason: verdict.reason, exitCode: 0, message: verdict.message });
      }
    });
  }

  cancel(reason?: string): void {
    this.stop({ outcome: "cancelled", ...(reason ? { reason } : {}) });
  }

  shutdown(): void {
    this.stop({ outcome: "error", reason: "node_shutdown", exitCode: null });
  }

  /**
   * 订阅事件流：先同步补发 seq > after 的缓冲事件，再接收实时事件。
   * 返回取消订阅函数。
   */
  subscribe(after: number, sub: Subscriber): () => void {
    for (const e of this.events) if (e.seq > after) sub(e);
    if (this.isFinished) return () => {};

    this.subscribers.add(sub);
    this.disarmLease();
    return () => {
      this.subscribers.delete(sub);
      if (this.subscribers.size === 0 && !this.isFinished) this.armLease();
    };
  }

  heartbeat(): RemoteEvent {
    return { type: "heartbeat", ts: new Date().toISOString(), lastSeq: this.lastSeq };
  }

  // ---------------------------------------------------------------- internals

  private pipeOutput(child: ChildProcess, stream: "stdout" | "stderr"): void {
    // StringDecoder 保证多字节字符（中文）不会在 chunk 边界被截断成乱码
    const decoder = new StringDecoder("utf8");
    const src = child[stream];
    if (!src) return;
    src.on("data", (chunk: Buffer) => {
      if (this.isFinished) return;
      this.outputBytes += chunk.length;
      if (this.outputBytes > this.cfg.maxOutputBytes) {
        this.stop({ outcome: "error", reason: "output_limit_exceeded", exitCode: null });
        return;
      }
      const data = decoder.write(chunk);
      if (data) this.route(stream, data);
      this.resetIdle();
    });
    src.on("end", () => {
      const rest = decoder.end();
      if (rest && !this.isFinished) this.route(stream, rest);
    });
  }

  /** stdout 交给解析器（如果有），stderr 和无解析器的 stdout 原样转发 */
  private route(stream: "stdout" | "stderr", data: string): void {
    if (stream === "stdout" && this.parser) this.emitParsed(this.parser.push(data));
    else this.push({ type: "output", seq: 0, ts: "", stream, data });
  }

  private emitParsed(items: ParserOutput[]): void {
    for (const item of items) {
      if (item.kind === "text_delta") this.push({ type: "text_delta", seq: 0, ts: "", text: item.text });
      else this.push({ type: "output", seq: 0, ts: "", stream: "stdout", data: item.line + "\n" });
    }
  }

  /** 决定终止：记下原因并杀进程树；terminal 在进程 close 后产出。没有进程时直接结束。 */
  private stop(outcome: RemoteTerminal): void {
    if (this.isFinished || this.pendingOutcome) return;
    this.pendingOutcome = outcome;
    this.clearTimers();
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      killTree(this.child, this.cfg.killGraceMs);
      // 兜底：即使 close 永远不来（管道被某个漏杀的孙进程占着），也保证产出 terminal
      setTimeout(() => this.finish(outcome), this.cfg.killGraceMs + 5_000).unref();
    } else if (!this.child) {
      this.finish(outcome);
    }
  }

  private finish(result: RemoteTerminal): void {
    if (this.isFinished) return; // 单次守卫：保证恰好一个 terminal
    this.terminal = result;
    this.clearTimers();
    this.push({ type: "terminal", seq: 0, ts: "", result });
    this.finishedAt = Date.now();
    this.subscribers.clear();
    this.onFinished(this);
  }

  private push(partial: SeqEvent): void {
    const event = { ...partial, seq: this.seq++, ts: new Date().toISOString() } as SeqEvent;
    this.events.push(event);
    for (const sub of this.subscribers) sub(event);
  }

  private resetIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    // TODO(Phase 1)：有待回答的权限请求时暂停 idle 计时（V0.4 §20）
    this.idleTimer = setTimeout(
      () => this.stop({ outcome: "timed_out", kind: "idle" }),
      this.limits.idleTimeoutMs,
    );
  }

  private armLease(): void {
    this.disarmLease();
    this.leaseTimer = setTimeout(
      () => this.stop({ outcome: "error", reason: "lease_expired", exitCode: null }),
      this.cfg.leaseMs,
    );
  }

  private disarmLease(): void {
    if (this.leaseTimer) clearTimeout(this.leaseTimer);
    this.leaseTimer = undefined;
  }

  private clearTimers(): void {
    for (const t of [this.idleTimer, this.totalTimer, this.leaseTimer]) if (t) clearTimeout(t);
    this.idleTimer = this.totalTimer = this.leaseTimer = undefined;
  }
}

function buildEnv(profile: Profile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of profile.envAllowlist) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return { ...env, ...profile.env };
}
