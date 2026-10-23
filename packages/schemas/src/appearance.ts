import { z } from "zod";
import { prefixedId } from "./common";

/**
 * 外观（C-32，Phase 1B-1）：头像、聊天背景、你自己的显示名。
 *
 * 图片的存放规则：
 * - 图片只经过 main：用户在系统文件对话框里选图，main 按**文件头**判断真实类型（不看扩展名），
 *   检查大小，原子写入 userData 下的 images/，文件名用新的 ULID（不用用户的文件名）
 * - renderer 永远拿不到文件路径，只拿 ImageRef；显示时用 `${IMAGE_URL_SCHEME}://<ImageRef>`
 * - 一张图不再被任何参与者或外观设置引用时，main 删除它（启动时也会清理没人引用的图）
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
  /** 你在聊天里的名字，例如「江浩」 */
  userDisplayName: z.string().min(1).max(40),
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
