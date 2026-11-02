import { failStaleTranscribing, getVoiceRecording, markVoiceFailed, markVoiceReady } from "@room/db";
import type { SqliteDatabase } from "@room/db";
import { CHAT_LIMITS, type AudioRef, type ControlEvent, type VoiceRecording } from "@room/schemas";
import type { CommandRequest, QueryRequest } from "@room/schemas";
import { ChatError } from "./chat";
import type { Transcriber } from "./voice-transcriber";
import type { VoiceRejectedError, VoiceStore } from "./voice-store";

/**
 * 录音导入与本地转写（D-34b 第二段，ADR-004 转写一节）。
 *
 * 流程：chat.voice.import（base64 字节）→ 校验格式 / 大小 → 按内容去重 → 落库（transcribing）
 *      → 异步交给本地 sidecar 转写 → ready（推 chat.voice.updated）/ failed（带原因）。
 * 转写只在主控机本地做，不上传第三方。
 */

export interface VoiceServiceDeps {
  db: SqliteDatabase;
  store: VoiceStore;
  /** 没配置（userData/asr.json 缺失）时是 null：import 明确拒绝，不假装成功 */
  transcriber: Transcriber | null;
  emit: (event: ControlEvent) => void;
  now?: () => string;
}

export class VoiceService {
  #chain: Promise<void> = Promise.resolve();

  constructor(private readonly deps: VoiceServiceDeps) {}

  /** chat.voice.import：收 base64、校验、落库，然后排队转写 */
  async import(command: CommandRequest<"chat.voice.import">): Promise<VoiceRecording> {
    if (this.deps.transcriber === null) {
      throw new ChatError("validation_failed", "本地转写还没配好（userData/asr.json），语音先用不了");
    }
    const bytes = decodeBase64Strict(command.data);
    if (bytes === null) throw new ChatError("validation_failed", "录音数据不是标准 base64");
    if (bytes.length > CHAT_LIMITS.voiceImportMaxBytes) {
      throw new ChatError("validation_failed", "录音太大（上限 16 MB）");
    }
    let added;
    try {
      added = await this.deps.store.add({ format: command.format, bytes });
    } catch (error) {
      const rejected = error as VoiceRejectedError;
      if (typeof rejected.code === "string" && typeof rejected.message === "string") {
        throw new ChatError("validation_failed", rejected.message);
      }
      throw error;
    }
    if (added.created) this.#enqueue(added.recording.audio);
    return added.recording;
  }

  /** chat.voice.get */
  get(query: QueryRequest<"chat.voice.get">): VoiceRecording {
    const recording = getVoiceRecording(this.deps.db, query.audio);
    if (recording === null) throw new ChatError("not_found", "这段录音不存在");
    return recording;
  }

  /**
   * 启动时收尾：上一次没转完的录音记成 failed（「应用重启，转写中断」）。
   * 返回收尾了几条，调用方打日志。
   */
  repairInterrupted(): number {
    return failStaleTranscribing(this.deps.db, "应用重启，转写中断");
  }

  /** 关窗时停掉 sidecar */
  dispose(): void {
    this.deps.transcriber?.dispose();
  }

  #enqueue(audio: AudioRef): void {
    this.#chain = this.#chain.then(() => this.#transcribe(audio)).catch((error: unknown) => {
      console.warn("[voice] 转写队列出错：", error instanceof Error ? error.message : String(error));
    });
  }

  async #transcribe(audio: AudioRef): Promise<void> {
    const transcriber = this.deps.transcriber;
    if (transcriber === null) return;
    const hit = this.deps.store.resolveAudio(audio);
    if (hit === null) {
      this.#settleFailed(audio, "录音本体找不到了");
      return;
    }
    try {
      const result = await transcriber.transcribe(hit.file);
      const text = result.text.trim();
      // 静音 / 没人说话：契约要求 ready 必须有非空转写，这种走 failed
      if (text.length === 0) throw new Error("没听到说话");
      markVoiceReady(this.deps.db, audio, {
        text,
        language: result.language,
        source: "transcribed",
        engine: { engine: "faster-whisper", model: this.#modelName() },
      });
      this.#emitUpdated(audio);
    } catch (error) {
      this.#settleFailed(audio, error instanceof Error ? error.message : String(error));
    }
  }

  #settleFailed(audio: AudioRef, message: string): void {
    try {
      markVoiceFailed(this.deps.db, audio, message.slice(0, 2000) || "转写失败");
      this.#emitUpdated(audio);
    } catch (error) {
      // 已经被收尾过（比如重启修复）就不再改
      console.warn("[voice] 转写失败收尾跳过：", error instanceof Error ? error.message : String(error));
    }
  }

  #emitUpdated(audio: AudioRef): void {
    const recording = getVoiceRecording(this.deps.db, audio);
    if (recording !== null) this.deps.emit({ type: "chat.voice.updated", recording });
  }

  #modelName(): string {
    return (this.deps.transcriber as { modelName?: string }).modelName ?? "faster-whisper";
  }
}

/** 标准 base64（允许结尾 = 补齐）；不是就返回 null */
function decodeBase64Strict(data: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0) return null;
  return bytes.toString("base64") === data ? bytes : null;
}

