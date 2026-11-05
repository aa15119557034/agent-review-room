import { z } from "zod";

/**
 * 语音包「应用内导入」（#209）。
 *
 * 只有两个包：runtime（Python 运行环境）和 model（模型）。界面按 TtsPackStatus 画「已安装 / 未安装」列表和进度条，
 * 导入动作只说「哪个包、zip 还是文件夹」。**renderer 不传、也拿不到任何要读写的路径**（和 workspace.* 一致）：
 * 选择框由 main 弹，解压到临时目录、校验、原子替换都在 main 里做。
 * 响应里的 path 只用来展示「装在哪」，不能再拿回去当入参。
 */
export const TtsPackKind = z.enum(["runtime", "model"]);
export type TtsPackKind = z.infer<typeof TtsPackKind>;

/** installed：版本对得上；missing：没找到；version_mismatch：找到了但版本和程序要的不一致 */
export const TtsPackState = z.enum(["installed", "missing", "version_mismatch"]);
export type TtsPackState = z.infer<typeof TtsPackState>;

/** 失败给原因码，不抛原始异常。PACK_BUSY：已有一个导入在跑 */
export const TtsPackErrorCode = z.enum([
  "PACK_NOT_FOUND",
  "PACK_INCOMPLETE",
  "PACK_VERSION_MISMATCH",
  "PACK_ARCHIVE_INVALID",
  "PACK_BUSY",
]);
export type TtsPackErrorCode = z.infer<typeof TtsPackErrorCode>;

export const TtsPackProgress = z
  .object({
    phase: z.enum(["extracting", "checking", "ready", "failed"]),
    doneBytes: z.number().int().nonnegative(),
    /** 压缩包里没写总大小时为 null */
    totalBytes: z.number().int().nonnegative().nullable(),
    /** 只在 phase = failed 时有 */
    error: TtsPackErrorCode.nullable(),
  })
  .strict()
  .refine((p) => (p.phase === "failed") === (p.error !== null), {
    message: "error 只在 phase = failed 时出现，且 failed 必须有 error",
  });
export type TtsPackProgress = z.infer<typeof TtsPackProgress>;

export const TtsPackStatus = z
  .object({
    kind: TtsPackKind,
    state: TtsPackState,
    /** 已装包自己写的版本；没装是 null */
    version: z.string().max(100).nullable(),
    /** 当前程序要求的版本 */
    expectedVersion: z.string().max(100),
    /** 只用来展示；没装是 null */
    path: z.string().max(1000).nullable(),
    /** 版本对不上 / 不完整时缺的相对路径，最多列 20 个 */
    missing: z.array(z.string().max(300)).max(20),
    totalBytes: z.number().int().nonnegative().nullable(),
    /** 正在导入或刚失败时才有；空闲是 null */
    progress: TtsPackProgress.nullable(),
  })
  .strict();
export type TtsPackStatus = z.infer<typeof TtsPackStatus>;

/** 固定两项：runtime 在前，model 在后 */
export const TtsPacks = z.array(TtsPackStatus).max(2);
export type TtsPacks = z.infer<typeof TtsPacks>;

export const TtsPacksRequest = z.object({ type: z.literal("tts.packs") }).strict();

/** 没有 path：选择框由 main 弹 */
export const TtsImportRequest = z
  .object({ type: z.literal("tts.import"), kind: TtsPackKind, mode: z.enum(["zip", "folder"]) })
  .strict();
export type TtsImportRequest = z.infer<typeof TtsImportRequest>;

/** cancelled：用户关了选择框，什么都没动。失败时 error 有值，packs 仍是最新状态 */
export const TtsImportResult = z
  .object({ cancelled: z.boolean(), error: TtsPackErrorCode.nullable(), packs: TtsPacks })
  .strict()
  .refine((r) => !(r.cancelled && r.error !== null), { message: "取消不会带错误" });
export type TtsImportResult = z.infer<typeof TtsImportResult>;
