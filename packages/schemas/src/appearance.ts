import { z } from "zod";
import { prefixedId } from "./common";

/**
 * 外观（C-32，Phase 1B-1）：头像、聊天背景、你自己的显示名。
 *
 * 图片的存放规则：
 * - 图片只经过 main：用户在系统文件对话框里选图，main 按**文件头**判断真实类型（不看扩展名），
 *   检查大小，原子写入 userData 下的 images/，文件名用新的 ULID（不用用户的文件名）。
 *   main 同时记下每张图的类型和用途（avatar / background）
 * - renderer 永远拿不到文件路径，只拿 ImageRef；显示时用 `${IMAGE_URL_SCHEME}://<ImageRef>`
 * - 用到 ImageRef 的命令（agent.update、appearance.update）由 main 校验：**这张图必须存在、用途必须匹配**
 *   （头像只能用 avatar 的图，背景只能用 background 的图），否则 validation_failed
 * - 清理：每次 agent.update / appearance.update 成功后，删除「没有任何引用、而且不是最近 24 小时内 pick 的」图；
 *   启动时按同一规则再清一次（刚选、还没保存的图不会被误删）
 *
 * `room-image://` 的约束（实现必须保证）：
 * - 只接受 `room-image://img_<ULID>`，别的形式一律 404；路径由 main 按自己的记录映射，不拼接请求里的任何东西
 * - 注册为只读、不可导航的 scheme（不能当页面打开，不能写）
 * - 只允许 png / jpeg / webp：**不允许 SVG**，因为 SVG 里可以带脚本和外链，作为图片显示也有风险；以后要加 SVG 先改契约
 *
 * 外观设置存在 main 的 settings.json（和节点设置放在一起），不进数据库；没设置过时 appearance.get 返回 DEFAULT_APPEARANCE。
 * 1A 的数据库里 avatar_ref 是任意字符串（实际都是 null）：main 读到不是 ImageRef 格式的值一律当 null，迁移 v4 顺手清成 null。
 */

/** 图片引用：img_<ULID>，不含扩展名（真实类型由 main 记录） */
export const ImageRef = prefixedId("img");
export type ImageRef = z.infer<typeof ImageRef>;

/** renderer 用 `room-image://img_…` 显示图片；main 只按 ImageRef 查自己记录的文件，不接受路径 */
export const IMAGE_URL_SCHEME = "room-image";

/** 允许的图片类型（按文件头判断） */
export const ImageMime = z.enum(["image/png", "image/jpeg", "image/webp"]);
export type ImageMime = z.infer<typeof ImageMime>;

/** 图片用途决定大小上限 */
export const ImagePurpose = z.enum(["avatar", "background"]);
export type ImagePurpose = z.infer<typeof ImagePurpose>;

export const IMAGE_MAX_BYTES: Readonly<Record<ImagePurpose, number>> = {
  avatar: 2 * 1024 * 1024,
  background: 8 * 1024 * 1024,
};

/** 聊天背景：内置的几种，或者自己的图片 */
export const ChatBackground = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("preset"), id: z.enum(["plain", "paper", "night"]) }),
  z.object({ kind: z.literal("image"), ref: ImageRef }),
]);
export type ChatBackground = z.infer<typeof ChatBackground>;

export const AppearanceSettings = z.object({
  /** 你在聊天里的名字，例如「江浩」。去掉首尾空格后不能为空 */
  userDisplayName: z.string().trim().min(1).max(40),
  /** 你的头像；null 时显示名字的第一个字 */
  userAvatarRef: ImageRef.nullable(),
  chatBackground: ChatBackground,
});
export type AppearanceSettings = z.infer<typeof AppearanceSettings>;

/** 还没设置过时 main 返回这个 */
export const DEFAULT_APPEARANCE: AppearanceSettings = {
  userDisplayName: "我",
  userAvatarRef: null,
  chatBackground: { kind: "preset", id: "plain" },
};
