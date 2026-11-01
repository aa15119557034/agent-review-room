import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
/**
 * ComfyUI 客户端（D-38a，ADR-004 §3）。
 *
 * 只做三件事：问它活着没有、按固定工作流画一张、打断正在跑的任务。
 * 工作流必须是你在 ComfyUI 里「导出为 API 格式」的那个 JSON（我们只填四个字段：提示词、宽、高、种子，
 * 其余字段保持导出时的值），这是 ADR 定的；不接收模型传来的工作流或别的字段。
 *
 * 所有 HTTP 都从一个可注入的 fetch 走（测试用假 ComfyUI，不连真机）。
 */

export interface ComfyUiField {
  /** 工作流 JSON 里的节点 id（字符串），例如 "6" */
  node: string;
  /** 节点 inputs 里的字段名，例如 "text"、"width"、"height"、"seed" */
  field: string;
}

export interface ComfyUiMapping {
  prompt: ComfyUiField;
  width: ComfyUiField;
  height: ComfyUiField;
  seed: ComfyUiField;
}

export interface ComfyUiConfig {
  /** 只监听本机：http://127.0.0.1:8188 */
  baseUrl: string;
  /** 「导出为 API 格式」的 JSON：节点 id → { inputs: {...}, class_type } */
  workflow: Record<string, unknown>;
  mapping: ComfyUiMapping;
  /** 每个任务最多等多久（毫秒），超时按 timed_out 收尾 */
  totalTimeoutMs?: number;
  /** 轮询 /history 的间隔 */
  pollIntervalMs?: number;
  /** 问一次「活着没有」的超时 */
  healthTimeoutMs?: number;
}

export interface ComfyUiDrawInput {
  prompt: string;
  /** 契约里的尺寸字符串，例如 "1024x1024" */
  size: string;
  seed: number;
}

export interface ComfyUiDrawResult {
  image: Buffer;
  seed: number;
  /** 工作流里写死的模型名（拿不到为 null） */
  model: string | null;
  /** 工作流 JSON（填字段之前的模板）的 sha256：来源记录要用（ADR-004 §3） */
  workflowHash: string;
}

export class ComfyUiError extends Error {
  readonly code: "unavailable" | "rejected" | "timeout" | "bad_output" | "cancelled";

  constructor(code: ComfyUiError["code"], message: string) {
    super(message);
    this.name = "ComfyUiError";
    this.code = code;
  }
}

type FetchFn = typeof fetch;

const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 400;
const DEFAULT_HEALTH_TIMEOUT_MS = 1_000;

export class ComfyUiClient {
  readonly #cfg: ComfyUiConfig;
  readonly #fetch: FetchFn;
  /** 正在跑的 prompt_id（打断用） */
  #activePromptId: string | null = null;

  constructor(config: ComfyUiConfig, fetchFn: FetchFn = fetch) {
    this.#cfg = config;
    this.#fetch = fetchFn;
  }

  /** 活着没有：GET /system_stats，1 秒超时；任何失败都算不可用 */
  async isUp(): Promise<boolean> {
    const timeout = this.#cfg.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await this.#fetch(new URL("/system_stats", this.#cfg.baseUrl), { signal: controller.signal });
      await res.body?.cancel();
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 工作流里写死的模型名：从任意节点的 inputs 里找 model / ckpt_name / unet_name */
  modelName(): string | null {
    for (const node of Object.values(this.#cfg.workflow)) {
      const inputs = (node as { inputs?: Record<string, unknown> }).inputs;
      if (inputs === undefined) continue;
      for (const key of ["ckpt_name", "unet_name", "model", "model_name"]) {
        const value = inputs[key];
        if (typeof value === "string" && value.length > 0) return value;
      }
    }
    return null;
  }

  /**
   * 按固定工作流画一张：填提示词 / 宽 / 高 / 种子 → POST /prompt → 轮询 /history → 取图。
   * 失败分四种：不可用（连不上）、被拒（HTTP 非 2xx）、超时、输出不对。
   */
  async draw(input: ComfyUiDrawInput, opts: { signal?: AbortSignal } = {}): Promise<ComfyUiDrawResult> {
    const [width, height] = parseSize(input.size);
    const prompt = this.#buildPrompt({ prompt: input.prompt, width, height, seed: input.seed });
    const clientId = `room-${Date.now()}-${Math.trunc(Math.random() * 1e6)}`;
    const interval = this.#cfg.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

    // 总时限从 draw() 一开始算（不是等 /prompt 回来才算）；所有请求都吃这个 signal（林离 #123）
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.#cfg.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS);
    const signal = combineSignals(opts.signal, deadline.signal);
    const abortCause = (): ComfyUiError =>
      opts.signal?.aborted ? new ComfyUiError("cancelled", "任务被取消了") : new ComfyUiError("timeout", "ComfyUI 画图超时");

    try {
      if (signal.aborted) throw abortCause();
      let promptId: string;
      try {
        const res = await this.#fetch(new URL("/prompt", this.#cfg.baseUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, client_id: clientId }),
          signal,
        });
        if (!res.ok) throw new ComfyUiError("rejected", `ComfyUI 拒绝了这次请求（HTTP ${res.status}）`);
        const body = (await res.json()) as { prompt_id?: unknown };
        if (typeof body.prompt_id !== "string") throw new ComfyUiError("bad_output", "ComfyUI 没有返回 prompt_id");
        promptId = body.prompt_id;
      } catch (error) {
        if (signal.aborted) throw abortCause();
        if (error instanceof ComfyUiError) throw error;
        throw new ComfyUiError("unavailable", "连不上 ComfyUI（127.0.0.1:8188）");
      }
      this.#activePromptId = promptId;

      for (;;) {
        if (signal.aborted) throw abortCause();
        await sleep(interval);
        if (signal.aborted) throw abortCause();
        const entry = await this.#historyEntry(promptId, signal);
        if (entry === null) continue;
        if (entry.status !== "completed") {
          throw new ComfyUiError("rejected", `ComfyUI 这次没画成（${String(entry.status)}）`);
        }
        const output = entry.images.find((image) => image.type === "output") ?? entry.images[0];
        const image = await this.#fetchImage(output, signal);
        return { image, seed: input.seed, model: this.modelName(), workflowHash: this.workflowHash() };
      }
    } catch (error) {
      // 超时：像取消一样收尾——先删我们的队列项，只有确认在跑才打断，
      // 不能把用户在 ComfyUI 里手动跑的任务一起停掉（C酱 #123）
      if (!opts.signal?.aborted && deadline.signal.aborted) await this.cancelActive();
      throw error;
    } finally {
      clearTimeout(timer);
      this.#activePromptId = null;
    }
  }

  /** 工作流模板（填字段之前）的 sha256，来源记录要用 */
  workflowHash(): string {
    return createHash("sha256").update(JSON.stringify(this.#cfg.workflow), "utf8").digest("hex");
  }

  /**
   * 取消当前任务：先把我们的 prompt 从 ComfyUI 队列里删掉；只有确认它**正在跑**才打断，
   * 否则会误停用户在 ComfyUI 里手动跑的别的任务（林离/C酱 #123）。
   */
  async cancelActive(): Promise<void> {
    const id = this.#activePromptId;
    if (id === null) return;
    const running = await this.#isRunning(id);
    try {
      await this.#fetch(new URL("/queue", this.#cfg.baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [id] }),
      });
    } catch {
      // 删队列失败就靠下面的 interrupt（如果确认在跑）
    }
    if (running) await this.interrupt();
  }

  /** GET /queue 看我们的 prompt 是不是正在执行的那个（不是就只排队，删掉就行） */
  async #isRunning(promptId: string): Promise<boolean> {
    try {
      const res = await this.#fetch(new URL("/queue", this.#cfg.baseUrl));
      if (!res.ok) return false;
      const body = (await res.json()) as { queue_running?: unknown[] };
      return (body.queue_running ?? []).some((entry) => Array.isArray(entry) && entry[1] === promptId);
    } catch {
      return false;
    }
  }

  /** 打断正在跑的任务（「停」/取消用）。没有在跑的任务就什么都不做 */
  async interrupt(): Promise<void> {
    if (this.#activePromptId === null) return;
    try {
      await this.#fetch(new URL("/interrupt", this.#cfg.baseUrl), { method: "POST" });
    } catch {
      // 打断失败不影响本地状态：任务照样按取消收尾，结果到达时丢掉
    }
  }

  #buildPrompt(input: { prompt: string; width: number; height: number; seed: number }): Record<string, unknown> {
    const workflow = structuredClone(this.#cfg.workflow) as Record<string, { inputs?: Record<string, unknown> }>;
    const set = (field: ComfyUiField, value: unknown): void => {
      const node = workflow[field.node];
      if (node === undefined || node.inputs === undefined) {
        throw new ComfyUiError("bad_output", `工作流里没有节点 ${field.node}`);
      }
      node.inputs[field.field] = value;
    };
    set(this.#cfg.mapping.prompt, input.prompt);
    set(this.#cfg.mapping.width, input.width);
    set(this.#cfg.mapping.height, input.height);
    set(this.#cfg.mapping.seed, input.seed);
    return workflow;
  }

  async #historyEntry(promptId: string, signal?: AbortSignal): Promise<{ status: string; images: { filename: string; subfolder: string; type: string }[] } | null> {
    const res = await this.#fetch(new URL(`/history/${encodeURIComponent(promptId)}`, this.#cfg.baseUrl), { signal });
    if (!res.ok) {
      if (res.status === 404) return null;
      throw new ComfyUiError("unavailable", `读 ComfyUI 任务状态失败（HTTP ${res.status}）`);
    }
    const body = (await res.json()) as Record<string, unknown>;
    const entry = body[promptId] as
      | {
          status?: { status_str?: string; completed?: boolean };
          outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
        }
      | undefined;
    if (entry === undefined) return null;
    const status = entry.status?.completed === true ? "completed" : (entry.status?.status_str ?? "pending");
    const images = Object.values(entry.outputs ?? {})
      .flatMap((output) => output.images ?? [])
      .map((image) => ({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" }));
    return { status, images };
  }

  async #fetchImage(image: { filename: string; subfolder: string; type: string } | undefined, signal?: AbortSignal): Promise<Buffer> {
    if (image === undefined) throw new ComfyUiError("bad_output", "ComfyUI 说画完了，但没给图");
    const url = new URL("/view", this.#cfg.baseUrl);
    url.searchParams.set("filename", image.filename);
    url.searchParams.set("subfolder", image.subfolder);
    url.searchParams.set("type", image.type);
    const res = await this.#fetch(url, { signal });
    if (!res.ok) throw new ComfyUiError("unavailable", `取图失败（HTTP ${res.status}）`);
    return Buffer.from(await res.arrayBuffer());
  }
}

const parseSize = (size: string): [number, number] => {
  const [w, h] = size.split("x").map((n) => Number(n));
  if (!Number.isInteger(w) || !Number.isInteger(h) || (w ?? 0) <= 0 || (h ?? 0) <= 0) {
    throw new ComfyUiError("bad_output", "尺寸格式不对：" + size);
  }
  return [w as number, h as number];
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 从 userData/comfyui.json 读配置（工作流是你在 ComfyUI 里「导出为 API 格式」的那个 JSON）。
 * 文件不存在 / 解析失败 / 缺字段都返回 null（= 本机画图不可用），启动时记一行 warn。
 *
 * 格式：
 * {
 *   "baseUrl": "http://127.0.0.1:8188",
 *   "workflow": { "6": { "inputs": { "text": "" }, "class_type": "..." }, ... },
 *   "mapping": { "prompt": {"node":"6","field":"text"}, "width": {...}, "height": {...}, "seed": {...} }
 * }
 */
export function loadComfyUiConfigFile(path: string): ComfyUiConfig | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ComfyUiConfig>;
    if (typeof raw.baseUrl !== "string" || raw.workflow === null || typeof raw.workflow !== "object") return null;
    // 只连本机：提示词里有你的聊天内容，不能发到别的机器上（ADR-004 §3）
    let url: URL;
    try {
      url = new URL(raw.baseUrl);
    } catch {
      return null;
    }
    if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname)) return null;
    const mapping = raw.mapping as ComfyUiMapping | undefined;
    if (mapping === undefined) return null;
    for (const key of ["prompt", "width", "height", "seed"] as const) {
      const field = mapping[key];
      if (field === undefined || typeof field.node !== "string" || typeof field.field !== "string") return null;
    }
    return {
      baseUrl: raw.baseUrl,
      workflow: raw.workflow,
      mapping,
      ...(typeof raw.totalTimeoutMs === "number" ? { totalTimeoutMs: raw.totalTimeoutMs } : {}),
      ...(typeof raw.pollIntervalMs === "number" ? { pollIntervalMs: raw.pollIntervalMs } : {}),
      ...(typeof raw.healthTimeoutMs === "number" ? { healthTimeoutMs: raw.healthTimeoutMs } : {}),
    };
  } catch {
    return null;
  }
}





/** ComfyUI 只允许本机：127.0.0.1 / localhost / [::1]（ADR-004 §3） */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);


/** 把取消 signal 和总时限 signal 合成一个（Node 20+ 的 AbortSignal.any 在类型里不一定有） */
const combineSignals = (...signals: (AbortSignal | undefined)[]): AbortSignal => {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 1) return present[0] as AbortSignal;
  const controller = new AbortController();
  for (const signal of present) {
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
};

