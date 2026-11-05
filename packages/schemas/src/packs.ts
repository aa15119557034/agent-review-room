import { z } from "zod";

/**
 * 「包」的应用内导入（#209，通用化）。
 *
 * 以后凡是要用户导入的 zip / 文件夹——语音运行环境、语音模型、补丁包、将来别的大文件包——都走这一套，
 * 不再各做一个导入入口。程序要知道哪些包，由 main 里的包登记表决定（id、名字、说明、要求的版本），
 * 界面只按 PackStatus 列表画行，不写死有几个、叫什么。
 *
 * 导入动作只说「哪个包（或让程序自己认）、zip 还是文件夹」。**renderer 不传、也拿不到任何要读写的路径**
 * （和 workspace.* 一致）：选择框由 main 弹，解压到临时目录、校验、原子替换都在 main 里做。
 * 响应里的 path 只用来展示「装在哪」，不能再拿回去当入参。
 *
 * 自动识别：压缩包 / 文件夹根部有 pack.json（{ id, version }，两项都必填，补丁包也要写 version）。id 是 null 时 main 按它认；认不出、或和指定的 id 不一致，
 * 都返回 PACK_UNKNOWN，什么也不改。
 */
export const PackId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);
export type PackId = z.infer<typeof PackId>;

/**
 * installed：版本对得上且文件齐；missing：没找到；version_mismatch：找到了但版本和程序要的不一致；
 * incomplete：找到了、版本对，但缺文件（缺的列在 missing[]）
 */
export const PackState = z.enum(["installed", "missing", "version_mismatch", "incomplete"]);
export type PackState = z.infer<typeof PackState>;

/**
 * 失败给原因码，不抛原始异常。PACK_BUSY：已有一个导入在跑；PACK_NO_SPACE：磁盘空间不够；
 * PACK_UNKNOWN：认不出这是哪个包（没有 pack.json、id 不在登记表里、或和指定的包不一致）
 */
export const PackErrorCode = z.enum([
  "PACK_NOT_FOUND",
  "PACK_INCOMPLETE",
  "PACK_VERSION_MISMATCH",
  "PACK_ARCHIVE_INVALID",
  "PACK_BUSY",
  "PACK_NO_SPACE",
  "PACK_UNKNOWN",
]);
export type PackErrorCode = z.infer<typeof PackErrorCode>;

export const PackProgress = z
  .object({
    phase: z.enum(["extracting", "checking", "ready", "failed"]),
    doneBytes: z.number().int().nonnegative(),
    /** 压缩包里没写总大小时为 null */
    totalBytes: z.number().int().nonnegative().nullable(),
    /** 只在 phase = failed 时有 */
    error: PackErrorCode.nullable(),
  })
  .strict()
  .refine((p) => (p.phase === "failed") === (p.error !== null), {
    message: "error 只在 phase = failed 时出现，且 failed 必须有 error",
  });
export type PackProgress = z.infer<typeof PackProgress>;

export const PackStatus = z
  .object({
    id: PackId,
    /** 给人看的名字和一句话说明，来自 main 的登记表 */
    label: z.string().min(1).max(100),
    description: z.string().max(300),
    state: PackState,
    /** 已装包自己写的版本；没装是 null */
    version: z.string().max(100).nullable(),
    /** 当前程序要求的版本；没有硬要求（比如补丁包）是 null */
    expectedVersion: z.string().max(100).nullable(),
    /** 只用来展示；没装是 null */
    path: z.string().max(1000).nullable(),
    /** 版本对不上 / 不完整时缺的相对路径，最多列 20 个 */
    missing: z.array(z.string().max(300)).max(20),
    totalBytes: z.number().int().nonnegative().nullable(),
    /**
     * 只有正在导入的那一个包有（extracting / checking）；失败后保留 phase = failed 和原因码，直到下一次导入开始；
     * 导入成功后清为 null。其它包、空闲时都是 null。查询（packs.list）不受导入进行中的影响，随时可查
     */
    progress: PackProgress.nullable(),
  })
  .strict();
export type PackStatus = z.infer<typeof PackStatus>;

/** 登记表里每个包一项；id 不重复；顺序由 main 定，界面照排 */
export const Packs = z
  .array(PackStatus)
  .max(50)
  .refine((l) => new Set(l.map((p) => p.id)).size === l.length, { message: "包 id 不能重复" });
export type Packs = z.infer<typeof Packs>;

export const PacksRequest = z.object({ type: z.literal("packs.list") }).strict();

/**
 * 没有 path：选择框由 main 弹。（暂无「取消导入」，要的话以后加 packs.cancel，记在 Phase 2 清单。）id 为 null = 让程序按 pack.json 自己认。
 * folder 模式：用户选「包含 pack.json 的目录」，或它的上一层（含 tts/ 这类单个子目录）都认；
 * zip 模式：压缩包顶层是包目录或直接是包内容都认。
 */
export const PackImportRequest = z
  .object({ type: z.literal("packs.import"), id: PackId.nullable(), mode: z.enum(["zip", "folder"]) })
  .strict();
export type PackImportRequest = z.infer<typeof PackImportRequest>;

/**
 * cancelled：用户关了选择框，什么都没动。成功或失败时 packId 是认出（或指定）的那个包，没认出来是 null。
 * 失败时 error 有值，packs 仍是最新状态
 */
export const PackImportResult = z
  .object({ cancelled: z.boolean(), packId: PackId.nullable(), error: PackErrorCode.nullable(), packs: Packs })
  .strict()
  .refine((r) => !(r.cancelled && r.error !== null), { message: "取消不会带错误" });
export type PackImportResult = z.infer<typeof PackImportResult>;
