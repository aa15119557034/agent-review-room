import type { TtsPackErrorCode, TtsPackKind } from "@room/schemas";
import type { RoomClient } from "./client";
import type { AppState } from "./state";
import type { Store } from "./store";

/** 语音包导入的原因码，给人看的话（#209）。不给原始异常 */
export const TTS_PACK_ERROR_TEXT: Record<TtsPackErrorCode, string> = {
  PACK_NOT_FOUND: "选的位置里没有找到语音包。",
  PACK_INCOMPLETE: "语音包不完整，缺了一些文件。",
  PACK_VERSION_MISMATCH: "语音包版本和程序要的不一致，请换对应版本的包。",
  PACK_ARCHIVE_INVALID: "压缩包打不开或内容不对，请重新下载后再试。",
  PACK_BUSY: "已经有一个语音包在导入，请等它完成。",
  PACK_NO_SPACE: "磁盘空间不够，请清理后再导入。",
};

/** 语音包（#209）。失败写进 notice，不向上抛；导入失败的原因码以文字留在返回值里给界面显示 */
export function createTtsPacksActions(store: Store<AppState>, client: RoomClient, fail: (err: unknown) => void) {
  return {
    async load() {
      try {
        const packs = await client.query({ type: "tts.packs" });
        store.set((s) => ({ ...s, ttsPacks: packs }));
      } catch (err) {
        fail(err);
      }
    },
    /** 返回失败原因码；成功或用户取消返回 null。状态变化走 tts.packs.updated 事件 */
    async import(kind: TtsPackKind, mode: "zip" | "folder"): Promise<TtsPackErrorCode | null> {
      try {
        const r = await client.command({ type: "tts.import", kind, mode });
        store.set((s) => ({ ...s, ttsPacks: r.packs }));
        return r.error;
      } catch (err) {
        fail(err);
        return null;
      }
    },
  };
}
