#!/usr/bin/env node
/**
 * 重启读回检查：把一个议题在 DB 里的全部内容归一化成 JSON，算 sha256。
 * 重启应用前后各跑一次，digest 一致就说明「整个话题完整读回」。
 *
 * 用法：
 *   node apps/desktop/scripts/readback-digest.mjs [dbPath] [projectNameLike]
 * 默认：
 *   dbPath      = %APPDATA%\@room\desktop\room.db
 *   projectName = 联调准备%
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const dbPath = process.argv[2] ?? join(process.env.APPDATA ?? "", "@room", "desktop", "room.db");
const projectLike = process.argv[3] ?? "联调准备%";
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const project = db.prepare("SELECT id, name FROM projects WHERE name LIKE ? ORDER BY created_at DESC LIMIT 1").get(projectLike);
if (project === undefined) {
  console.error("project not found: " + projectLike);
  process.exit(1);
}
const P = project.id;
const rounds = db.prepare("SELECT round_index, state, task, recipients, plan_version_id FROM rounds WHERE project_id = ? ORDER BY round_index").all(P);
const messages = db.prepare("SELECT kind, source_agent, round_id, turn_id, content FROM messages WHERE project_id = ? ORDER BY created_at, rowid").all(P);
const summaries = db.prepare("SELECT round_id, summarizer, answered, expected, report, plan_version_id FROM round_summaries WHERE round_id IN (SELECT id FROM rounds WHERE project_id = ?) ORDER BY created_at").all(P);
const plans = db.prepare("SELECT version, state, content, parent_id, based_on_round_id, change_note FROM plan_versions WHERE project_id = ? ORDER BY version").all(P);
const turns = db.prepare("SELECT agent, is_summary, outcome, on_behalf_of, partial_text FROM turns WHERE round_id IN (SELECT id FROM rounds WHERE project_id = ?) ORDER BY created_at, rowid").all(P);
const runs = db.prepare("SELECT id, state, failure_reason FROM runs WHERE id IN (SELECT run_id FROM turns WHERE round_id IN (SELECT id FROM rounds WHERE project_id = ?) AND run_id IS NOT NULL) ORDER BY id").all(P);
const counts = {
  rounds: rounds.length,
  messages: messages.length,
  summaries: summaries.length,
  plans: plans.length,
  turns: turns.length,
  runs: runs.length,
  batches: db.prepare("SELECT count(*) AS n FROM batches WHERE project_id = ?").get(P).n,
  snapshots: db.prepare("SELECT count(*) AS n FROM prompt_snapshots WHERE project_id = ?").get(P).n,
  runEvents: db.prepare("SELECT count(*) AS n FROM run_events WHERE run_id IN (SELECT run_id FROM turns WHERE round_id IN (SELECT id FROM rounds WHERE project_id = ?) AND run_id IS NOT NULL)").get(P).n,
};
const h = (s) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
const canonical = JSON.stringify({
  name: project.name,
  rounds: rounds.map((r) => [r.round_index, r.state, r.task, r.recipients, r.plan_version_id]),
  messages: messages.map((m) => [m.kind, m.source_agent, m.round_id, m.turn_id, h(m.content)]),
  summaries: summaries.map((s) => [s.round_id, s.summarizer, s.answered, s.expected, h(s.report), s.plan_version_id]),
  plans: plans.map((p) => [p.version, p.state, h(p.content), p.parent_id, p.based_on_round_id, p.change_note]),
  turns: turns.map((t) => [t.agent, t.is_summary, t.outcome, t.on_behalf_of, t.partial_text === null ? null : h(t.partial_text)]),
  runs: runs.map((r) => [r.id, r.state, r.failure_reason]),
  counts,
});
console.log(JSON.stringify({
  project: project.name,
  digest: h(canonical),
  counts,
  plans: plans.map((p) => p.version + ":" + p.state),
  rounds: rounds.map((r) => r.round_index + ":" + r.state),
}, null, 2));
db.close();
