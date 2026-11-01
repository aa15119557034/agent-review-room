import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { RemoteArtifact, RemoteEvent, RemoteTerminal, RunKind, StartRunRequest } from "@room/schemas";
import type { Profile, ServerConfig } from "./config";
import { killTree, spawnDetached } from "./process-tree";
import { createParser, type OutputParser, type ParserOutput } from "./parsers";
import { planSpawn } from "./win-command";
import { buildArgs } from "./model-args";
import { imageStdin } from "./images";
import { collectArtifact, discardFresh, listFiles, type HeldArtifact } from "./image-artifact";

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
  /** 请求里的模型和强度；undefined = 用 profile 自带的 */
  readonly model: StartRunRequest["model"];
  /** 省略 = text（幂等比较前先归一化） */
  readonly kind: RunKind;
  /** 随附图片的 sha256（按编号），幂等比较用；没带图为空 */
  readonly attachmentShas: readonly string[];

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
    this.model = req.model;
    this.kind = req.kind ?? "text";
    this.attachmentShas = (req.attachments ?? []).map((a) => a.sha256);
    this.limits = {
      idleTimeoutMs: Math.min(req.limits.idleTimeoutMs, profile.maxIdleTimeoutMs),
      totalTimeoutMs: Math.min(req.limits.totalTimeoutMs, profile.maxTotalTimeoutMs),
    };
    // 带图：按 profile.images 把文字和图片块写进 stdin（server.ts 已核对过字节、看图能力和 images 配置）
    if (req.attachments && req.imageSlot && profile.images) {
      this.input = imageStdin(profile.images.input, req.snapshot.content, req.imageSlot, req.attachments);
      this.extraArgs = profile.images.args;
    } else {
      this.input = req.snapshot.content;
      this.extraArgs = [];
    }
    this.parser = createParser(profile.parser);
  }

  private readonly limits: { idleTimeoutMs: number; totalTimeoutMs: number };
  private readonly input: string;
  private readonly extraArgs: readonly string[];
  /** image Run：起跑前 outputDir 里已有的文件 */
  private outputBefore: ReturnType<typeof listFiles> | undefined;
  /** image Run 画好、还没被取走的图 */
  private held: HeldArtifact | undefined;
  private heldTimer: NodeJS.Timeout | undefined;

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
  /** 还在节点上的生成图（取走或过期后为 undefined） */
  get artifact(): HeldArtifact | undefined {
    return this.held;
  }

  /** 生成图已经取走（或过期）：丢掉字节 */
  dropArtifact(): void {
    this.held = undefined;
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = undefined;
  }

  start(): void {
    // 订阅者必须在 leaseMs 内连上事件流，否则视为 Orchestrator 已经不在了
    this.armLease();
    this.totalTimer = setTimeout(
      () => this.stop({ outcome: "timed_out", kind: "total" }),
      this.limits.totalTimeoutMs,
    );
    this.resetIdle();

    if (this.kind === "image" && this.profile.imageRun) this.outputBefore = listFiles(this.profile.imageRun.outputDir);

    let child: ChildProcess;
    try {
      // Windows 上 .cmd / .bat 会被包装成 cmd.exe /d /s /c "…"，见 win-command.ts
      const plan = planSpawn(this.profile.command, [...buildArgs(this.profile, this.model), ...this.extraArgs]);
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
        else this.complete();
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
        this.complete();
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

  /** 进程正常结束。image Run 还要找到画好的图，找不到改报 error(incomplete_output)（契约 C-42b） */
  private complete(): void {
    if (this.kind !== "image") {
      this.finish({ outcome: "completed", exitCode: 0 });
      return;
    }
    const dir = this.profile.imageRun?.outputDir;
    let got: HeldArtifact | { problem: string };
    try {
      got = dir ? collectArtifact(dir, this.outputBefore ?? new Map()) : { problem: "profile has no imageRun.outputDir" };
    } catch (err) {
      got = { problem: `could not read generated image: ${(err as Error).message}` };
    }
    if ("problem" in got) {
      this.finish({ outcome: "error", reason: "incomplete_output", exitCode: 0, message: got.problem });
      return;
    }
    this.held = got;
    // 结束后超过 leaseMs 没人取就丢掉
    this.heldTimer = setTimeout(() => this.dropArtifact(), this.cfg.leaseMs);
    this.heldTimer.unref();
    const artifact: RemoteArtifact = got.meta;
    this.finish({ outcome: "completed", exitCode: 0, artifact });
  }

  private finish(result: RemoteTerminal): void {
    if (this.isFinished) return; // 单次守卫：保证恰好一个 terminal
    this.terminal = result;
    if (this.kind === "image" && result.outcome !== "completed" && this.profile.imageRun && this.outputBefore) {
      try {
        discardFresh(this.profile.imageRun.outputDir, this.outputBefore);
      } catch (err) {
        console.error(`[agent-server] run ${this.runId}: could not clean image output`, err);
      }
    }
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
