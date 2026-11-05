import type { PackErrorCode, PackId } from "@room/schemas";
import type { RoomClient } from "./client";
import type { AppState } from "./state";
import type { Store } from "./store";

/** 包导入的原因码，给人看的话（#209）。不给原始异常 */
export const PACK_ERROR_TEXT: Record<PackErrorCode, string> = {
  PACK_NOT_FOUND: "选的位置里没有找到这个包。",
  PACK_INCOMPLETE: "包不完整，缺了一些文件。",
  PACK_VERSION_MISMATCH: "包的版本和程序要的不一致，请换对应版本的包。",
  PACK_ARCHIVE_INVALID: "压缩包打不开或内容不对，请重新下载后再试。",
  PACK_BUSY: "已经有一个包在导入，请等它完成。",
  PACK_NO_SPACE: "磁盘空间不够，请清理后再导入。",
  PACK_UNKNOWN: "认不出这是哪个包（里面没有 pack.json，或不是这里登记过的包）。什么都没有改。",
};

/** 包导入（#209，契约 #214）。失败写进 notice，不向上抛；导入失败的原因码返回给界面显示 */
export function createPacksActions(store: Store<AppState>, client: RoomClient, fail: (err: unknown) => void) {
  return {
    async load() {
      try {
        const packs = await client.query({ type: "packs.list" });
        store.set((s) => ({ ...s, packs }));
      } catch (err) {
        fail(err);
      }
    },
    /**
     * id = null：让程序按 pack.json 自己认包。
     * 返回失败原因码；成功或用户取消返回 null。状态变化走 packs.updated 事件
     */
    async import(id: PackId | null, mode: "zip" | "folder"): Promise<PackErrorCode | null> {
      try {
        const r = await client.command({ type: "packs.import", id, mode });
        store.set((s) => ({ ...s, packs: r.packs }));
        return r.error;
      } catch (err) {
        fail(err);
        return null;
      }
    },
  };
}
