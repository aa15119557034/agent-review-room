import { z } from "zod";
import { IsoTimestamp, RunId, Sha256Hex } from "./common";
import { MessageId, ProjectId } from "./entities";
import { NoteScope } from "./notes";

export const WorkspaceItemKind = z.enum(["chat", "message", "plan", "note", "topic"]);
export const WorkspaceItemKey = z.object({ kind: WorkspaceItemKind, id: z.string().min(1).max(100) }).strict();
export type WorkspaceItemKey = z.infer<typeof WorkspaceItemKey>;
export const WorkspaceSearchHit = WorkspaceItemKey.extend({
  scope: NoteScope, title: z.string().max(300), preview: z.string().max(600), createdAt: IsoTimestamp,
}).strict();
export type WorkspaceSearchHit = z.infer<typeof WorkspaceSearchHit>;
export const WorkspaceCursor = z.object({ createdAt: IsoTimestamp, key: z.string().min(1).max(120) }).strict();
export const WorkspaceSearchRequest = z.object({
  type: z.literal("workspace.search"), term: z.string().trim().min(1).max(200),
  scope: NoteScope.optional(), before: WorkspaceCursor.optional(), limit: z.number().int().min(1).max(50).default(30),
}).strict();
export const WorkspaceSearchPage = z.object({
  items: z.array(WorkspaceSearchHit).max(50), nextCursor: WorkspaceCursor.nullable(),
}).strict();
export type WorkspaceSearchPage = z.infer<typeof WorkspaceSearchPage>;
export const WorkspaceItem = WorkspaceSearchHit.extend({ content: z.string().max(2_000_000), runId: RunId.nullable() }).strict();
export type WorkspaceItem = z.infer<typeof WorkspaceItem>;

export const WorkspaceHealthCheck = z.object({
  id: z.string().max(100), label: z.string().max(100),
  state: z.enum(["configured", "available", "unavailable", "unconfigured", "unknown"]),
  detail: z.string().max(500), checkedAt: IsoTimestamp,
}).strict();
export type WorkspaceHealthCheck = z.infer<typeof WorkspaceHealthCheck>;
export const WorkspaceHealth = z.object({
  version: z.string().max(100), revision: z.string().max(100), databaseVersion: z.number().int().nonnegative(),
  checks: z.array(WorkspaceHealthCheck).max(100), checkedAt: IsoTimestamp,
}).strict();
export type WorkspaceHealth = z.infer<typeof WorkspaceHealth>;

export const WorkspaceTask = z.object({
  id: z.string().max(100), kind: z.enum(["chat", "discussion", "media"]),
  state: z.string().max(40), failure: z.string().max(100).nullable(),
  createdAt: IsoTimestamp, startedAt: IsoTimestamp.nullable(), finishedAt: IsoTimestamp.nullable(),
  scope: NoteScope.nullable(),
}).strict();
export type WorkspaceTask = z.infer<typeof WorkspaceTask>;
export const WorkspaceTaskPage = z.object({
  items: z.array(WorkspaceTask).max(100), nextCursor: WorkspaceCursor.nullable(),
}).strict();
export type WorkspaceTaskPage = z.infer<typeof WorkspaceTaskPage>;

/** Whitelist only: no raw messages, prompt, environment, URLs, paths, or tokens. */
export const WorkspaceDiagnostics = z.object({
  format: z.literal("agent-room-diagnostics-v1"), createdAt: IsoTimestamp,
  version: z.string().max(100), revision: z.string().max(100), databaseVersion: z.number().int().nonnegative(),
  checks: z.array(z.object({ id: z.string().max(100), state: WorkspaceHealthCheck.shape.state }).strict()).max(100),
  tasks: z.array(WorkspaceTask.omit({ scope: true })).max(100),
}).strict();
export type WorkspaceDiagnostics = z.infer<typeof WorkspaceDiagnostics>;
export const WorkspaceFileResult = z.object({
  cancelled: z.boolean(), path: z.string().nullable(), files: z.number().int().nonnegative(),
}).strict();
export type WorkspaceFileResult = z.infer<typeof WorkspaceFileResult>;
export const WorkspaceBackupManifest = z.object({
  format: z.literal("agent-room-backup-v1"), createdAt: IsoTimestamp, version: z.string().max(100),
  revision: z.string().max(100), databaseVersion: z.number().int().nonnegative(),
  files: z.array(z.object({
    path: z.string().regex(/^(room\.db|(images|files|audio)\/[0-9a-f]{64})$/),
    bytes: z.number().int().nonnegative(), sha256: Sha256Hex,
  }).strict()).min(1).max(100_000),
}).strict();
export type WorkspaceBackupManifest = z.infer<typeof WorkspaceBackupManifest>;

export const WorkspaceDecisionId = z.string().regex(/^decision_[0-9A-HJKMNP-TV-Z]{26}$/);
export const WorkspaceDecisionState = z.enum(["pending", "accepted", "rejected", "deferred"]);
export const WorkspaceDecision = z.object({
  id: WorkspaceDecisionId, projectId: ProjectId, title: z.string().trim().min(1).max(300),
  state: WorkspaceDecisionState, reason: z.string().trim().max(4000),
  sourceMessageId: MessageId.nullable(), version: z.number().int().positive(), createdAt: IsoTimestamp,
}).strict();
export type WorkspaceDecision = z.infer<typeof WorkspaceDecision>;
export const WorkspaceDecisionSave = z.object({
  type: z.literal("workspace.decision.save"), id: WorkspaceDecisionId.optional(), projectId: ProjectId,
  title: WorkspaceDecision.shape.title, state: WorkspaceDecisionState, reason: WorkspaceDecision.shape.reason,
  sourceMessageId: MessageId.nullable(), expectedVersion: z.number().int().positive().nullable(),
}).strict();
export const WorkspaceExportPreview = z.object({
  scope: NoteScope, title: z.string().max(300), markdown: z.string().max(5_000_000),
  files: z.array(z.object({ ref: z.string(), name: z.string(), bytes: z.number().int().nonnegative() }).strict()).max(10_000),
  digest: Sha256Hex,
}).strict();
export type WorkspaceExportPreview = z.infer<typeof WorkspaceExportPreview>;

export const WorkspaceRestoreMarker = z.object({ format: z.literal("agent-room-restored-copy-v1"), createdAt: IsoTimestamp }).strict();
