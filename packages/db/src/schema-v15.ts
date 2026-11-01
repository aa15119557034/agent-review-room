/**
 * 迁移 v15（C-42g / X-34b）：Snapshot 的图片位置标记。
 *
 * 契约里 `ChatSnapshot.imageSlot`（`[图片位置 <nonce>]`）是「起跑时原样交给节点」的那个标记，
 * 带图的聊天 Run 没有它节点会拒（StartRun 的 refine）。v6 建表时只有 `attachments`，这一列是后来补的，
 * 所以单开一条迁移：`image_slot` 可空，老 Snapshot 保持 NULL（＝没带图）。
 */
export const SCHEMA_V15 = `
ALTER TABLE chat_snapshots ADD COLUMN image_slot TEXT;
`;
