import { sha256Hex } from "@room/core";
import type { ChatReplySlot, ChatRun, ChatSnapshot, UserChatMessage } from "@room/schemas";
import { createConversation, insertChatMessage, insertChatRun, insertChatSlot, insertChatSnapshot, ulid, type SqliteDatabase, type WriteQueue } from "../src/index";

export const SOURCE_TIME = "2026-11-17T00:00:00.000Z";
export function sourceUser(conversationId: string, text: string): UserChatMessage {
  return { id: "cmsg_" + ulid(), conversationId, sender: "user", content: { kind: "text", text, attachments: [] }, mentions: { kind: "none" }, quoteMessageId: null, replacesMessageId: null, state: "sent", retractedAt: null, createdAt: SOURCE_TIME };
}

export async function sourceChat(db: SqliteDatabase, queue: WriteQueue, agent = "deepseek") {
  const conversation = await createConversation(db, queue, { members: { kind: "direct", agent }, title: null });
  const question = sourceUser(conversation.id, "Use the source");
  insertChatMessage(db, { message: question });
  const slot: ChatReplySlot = { id: "slot_" + ulid(), conversationId: conversation.id, userMessageId: question.id, agent, required: true, outcome: "running", runId: "run_" + ulid(), attempt: 1, replyMessageId: null, failure: null, unavailableReason: null, createdAt: SOURCE_TIME, finishedAt: null };
  const snapshot: ChatSnapshot = { id: "snap_" + ulid(), purpose: "reply", conversationId: conversation.id, userMessageId: question.id, agent, content: "source prompt", contentHash: sha256Hex("source prompt"), nonce: "0123456789abcdef", memorySlot: null, includedMessageIds: [question.id], includedSummaryIds: [], adapterVersion: "test", tokenEstimate: 5, createdAt: SOURCE_TIME };
  const run: ChatRun = { id: slot.runId!, kind: "chat", purpose: "reply", conversationId: conversation.id, slotId: slot.id, agent, snapshotId: snapshot.id, snapshotHash: snapshot.contentHash, finalPromptHash: null, memoryManifest: null, model: null, adapterId: "remote:test", state: "RUNNING", substate: "active", failureReason: null, createdAt: SOURCE_TIME, startedAt: SOURCE_TIME, finishedAt: null };
  insertChatSnapshot(db, snapshot);
  insertChatSlot(db, slot);
  insertChatRun(db, run);
  return { conversation, question, slot, snapshot, run };
}

export function sourceProjectRun(db: SqliteDatabase) {
  const projectId = "proj_" + ulid(), snapshotId = "snap_" + ulid(), approvalId = "apr_" + ulid(), runId = "run_" + ulid();
  db.prepare("INSERT INTO projects (id, name, created_at) VALUES (?, 'sources', ?)").run(projectId, SOURCE_TIME);
  db.prepare("INSERT INTO prompt_snapshots (id, project_id, content, content_hash, nonce, contribution_ids, task_instruction, reviewer_agent, adapter_version, token_estimate, created_at) VALUES (?, ?, 'source prompt', ?, '0123456789abcdef', '[]', 'task', 'deepseek', 'test', 5, ?)").run(snapshotId, projectId, sha256Hex("source prompt"), SOURCE_TIME);
  db.prepare("INSERT INTO approvals (id, project_id, snapshot_id, state, created_at) VALUES (?, ?, ?, 'APPROVED', ?)").run(approvalId, projectId, snapshotId, SOURCE_TIME);
  db.prepare("INSERT INTO runs (id, project_id, approval_id, snapshot_id, adapter_id, state, substate, created_at, started_at) VALUES (?, ?, ?, ?, 'remote:test', 'RUNNING', 'active', ?, ?)").run(runId, projectId, approvalId, snapshotId, SOURCE_TIME, SOURCE_TIME);
  return { projectId, snapshotId, approvalId, runId };
}
