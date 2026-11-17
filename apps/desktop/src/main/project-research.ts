import { sha256Hex } from "@room/core";
import { approveAndCreateRun, currentProjectSources, insertResearchPlanTx, previewProjectSource, ProjectResearchError, readResearchPlan, readResultDisplay, ulid, type RunRow, type SqliteDatabase, type WriteQueue } from "@room/db";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { PROJECT_RESEARCH_COMMANDS, PROJECT_RESEARCH_QUERIES, ProjectResearchPreview, type ProjectResearchPlan, type CommandRequest, type ControlEvent, type QueryRequest } from "@room/schemas";
import type { Repository } from "./repository";
import type { SettingsStore } from "./settings";
import type { RunOrchestrator } from "./orchestrator";
import { researchResultSink } from "./research-results";

interface ProjectResearchServiceDeps {
    db: SqliteDatabase; queue: WriteQueue; repo: Repository; settings: SettingsStore;
    orchestrator: Pick<RunOrchestrator, "start">; emit: (event: ControlEvent) => void; fetchImpl?: typeof fetch;
}
type ResearchTarget = ProjectResearchPlan["target"] & { token: string };

export class ProjectResearchService {
  readonly #deps: ProjectResearchServiceDeps;
  readonly #context = new AbortController();
  constructor(deps: ProjectResearchServiceDeps) { this.#deps = deps; }

  /** Called before a workspace switch/close can release this database to late async work. */
  invalidate(): void { this.#context.abort(); }
  #assertContext = (): void => {
    if (this.#context.signal.aborted || !this.#deps.db.open) throw new ProjectResearchError("工作区已切换或关闭，请在当前项目重新准备检索");
  };
  #target(nodeId: string, profileId: string) {
    this.#assertContext();
    const row = this.#deps.repo.listNodeRows().find((node) => node.id === nodeId);
    const saved = this.#deps.settings.getNode(nodeId);
    if (!row?.base_url || !saved || row.base_url !== saved.baseUrl) throw new ProjectResearchError("请先在设置中保存检索节点及其 Token");
    return { nodeId, profileId, baseUrl: new URL(row.base_url).origin, token: saved.token };
  }
  #targetGuard(target: ResearchTarget): () => void {
    return () => {
      this.#assertContext();
      const current = this.#target(target.nodeId, target.profileId);
      if (current.baseUrl !== target.baseUrl || current.token !== target.token) throw new ProjectResearchError("检索节点配置已变化，请重新准备", "stale_snapshot");
    };
  }
  #adapter(target: ResearchTarget) {
    return { ...target, heartbeatTimeoutMs: 15_000, reconnectGraceMs: 30_000, requestTimeoutMs: 10_000, ...(this.#deps.fetchImpl ? { fetchImpl: this.#deps.fetchImpl } : {}) };
  }
  async #probe(target: ResearchTarget): Promise<void> {
    const guard = this.#targetGuard(target);
    const health = await new HttpRemoteAgentAdapter(this.#adapter(target)).health(this.#context.signal).catch(() => {
      guard();
      throw new ProjectResearchError("无法连接检索节点，请检查节点状态和凭据", "agent_unavailable");
    });
    guard();
    if (!health.profiles.includes(target.profileId) || health.capabilities?.structuredResults?.version !== 1 || !health.capabilities.structuredResults.profiles.includes(target.profileId) ||
        health.capabilities.projectResearch?.version !== 1 || !health.capabilities.projectResearch.profiles.includes(target.profileId)) throw new ProjectResearchError("此节点尚未提供项目检索能力，请更新节点或选择支持检索的 profile", "agent_unavailable");
  }
  async prepare(value: CommandRequest<"research.prepare">): Promise<ProjectResearchPreview> {
    const command = PROJECT_RESEARCH_COMMANDS["research.prepare"].request.parse(value);
    const target = this.#target(command.nodeId, command.profileId), guard = this.#targetGuard(target);
    if (!this.#deps.repo.listProjects().some((project) => project.id === command.projectId)) throw new ProjectResearchError("项目不存在");
    await this.#probe(target);
    guard();
    const plan: ProjectResearchPlan = { version: 1, projectId: command.projectId, snapshotId: "snap_" + ulid(), query: command.query, target: { nodeId: target.nodeId, baseUrl: target.baseUrl, profileId: target.profileId } };
    await this.#deps.queue.run(() => { guard(); this.#deps.db.transaction(() => insertResearchPlanTx(this.#deps.db, plan)).immediate(); });
    guard();
    const preview = this.preview({ type: "research.preview", projectId: plan.projectId, snapshotId: plan.snapshotId });
    this.#deps.emit({ type: "approval.updated", approval: preview.approval });
    return preview;
  }
  preview(value: QueryRequest<"research.preview">): ProjectResearchPreview {
    this.#assertContext();
    const query = PROJECT_RESEARCH_QUERIES["research.preview"].request.parse(value);
    const stored = readResearchPlan(this.#deps.db, query.snapshotId);
    if (!stored || stored.plan.projectId !== query.projectId) throw new ProjectResearchError("项目中没有这份检索计划", "not_found");
    const approval = this.#deps.db.prepare("SELECT id FROM approvals WHERE snapshot_id = ? AND project_id = ?").get(query.snapshotId, query.projectId) as { id: string } | undefined;
    if (!approval) throw new ProjectResearchError("检索批准不存在");
    return ProjectResearchPreview.parse({ ...stored, snapshot: this.#deps.repo.getSnapshot(query.snapshotId), approval: this.#deps.repo.getApproval(approval.id) });
  }
  async approve(value: CommandRequest<"research.approve">) {
    this.#assertContext();
    const command = PROJECT_RESEARCH_COMMANDS["research.approve"].request.parse(value);
    const approval = this.#deps.repo.getApproval(command.approvalId);
    const preview = this.preview({ type: "research.preview", projectId: approval.projectId, snapshotId: approval.snapshotId });
    if (preview.researchHash !== command.expectedResearchHash || preview.snapshot.contentHash !== command.expectedSnapshotHash) throw new ProjectResearchError("检索预览已变化，请重新准备", "stale_snapshot");
    const target = this.#target(preview.plan.target.nodeId, preview.plan.target.profileId), guard = this.#targetGuard(target);
    if (target.baseUrl !== preview.plan.target.baseUrl) throw new ProjectResearchError("批准的节点地址已变化，请重新准备", "stale_snapshot");
    await this.#probe(target);
    guard();
    const result = await approveAndCreateRun(this.#deps.db, this.#deps.queue, { approvalId: approval.id, expectedSnapshotHash: command.expectedSnapshotHash, expectedResearchHash: command.expectedResearchHash, adapterId: "remote:" + target.profileId, decidedVia: "desktop", beforeWrite: guard });
    guard();
    const response = { approval: this.#deps.repo.getApproval(approval.id), run: this.#deps.repo.getRun(result.run.id) };
    this.#deps.emit({ type: "approval.updated", approval: response.approval });
    this.#deps.emit({ type: "run.updated", run: response.run });
    void this.#deps.orchestrator.start(result.run, { snapshotId: preview.snapshot.id, content: preview.snapshot.content, contentHash: preview.snapshot.contentHash, reviewerAgent: target.profileId }).catch(() => console.error("[research] run settlement failed"));
    return response;
  }
  result(value: QueryRequest<"research.result">) {
    this.#assertContext();
    const query = PROJECT_RESEARCH_QUERIES["research.result"].request.parse(value), run = this.#deps.repo.getRun(query.runId);
    if (run.projectId !== query.projectId) throw new ProjectResearchError("该检索不属于当前项目", "not_found");
    const saved = readResearchPlan(this.#deps.db, run.snapshotId);
    if (!saved) throw new ProjectResearchError("该 Run 不是项目检索");
    const row = this.#deps.db.prepare("SELECT research_original_message_id AS id FROM runs WHERE id = ?").get(run.id) as { id: string | null };
    return { run, plan: saved.plan, originalMessageId: row.id, blocks: readResultDisplay(this.#deps.db, run.id) };
  }
  sources(value: QueryRequest<"sources.current">) { this.#assertContext(); return currentProjectSources(this.#deps.db, value); }
  sourcePreview(value: QueryRequest<"sources.preview">) { this.#assertContext(); return previewProjectSource(this.#deps.db, value); }

  async createAdapter(run: RunRow, signal: AbortSignal): Promise<HttpRemoteAgentAdapter> {
    this.#assertContext();
    const stored = readResearchPlan(this.#deps.db, run.snapshot_id);
    if (!stored || stored.plan.projectId !== run.project_id) throw new ProjectResearchError("检索运行与计划不匹配");
    const target = this.#target(stored.plan.target.nodeId, stored.plan.target.profileId), guard = this.#targetGuard(target);
    if (target.baseUrl !== stored.plan.target.baseUrl) throw new ProjectResearchError("批准的检索节点已变化", "stale_snapshot");
    let sink: ReturnType<typeof researchResultSink> | undefined;
    const adapter = new HttpRemoteAgentAdapter({ ...this.#adapter(target), projectResearch: {
      beforeStart: (request) => {
        guard();
        if (signal.aborted || request.runId !== run.id || request.snapshot.id !== stored.plan.snapshotId || request.snapshot.contentHash !== sha256Hex(stored.plan.query)) throw new ProjectResearchError("检索已取消或快照已变化");
        sink = researchResultSink({ db: this.#deps.db, queue: this.#deps.queue, request, signal, assertContext: guard,
          diagnostic: (reason) => console.warn("[research] rejected event:", reason),
          changed: (messageId) => {
            if (messageId !== null) this.#deps.emit({ type: "message.created", message: this.#deps.repo.getMessage(messageId) });
            this.#deps.emit({ type: "run.updated", run: this.#deps.repo.getRun(run.id) });
          },
        });
      },
      onEvent: async (event) => { if (!sink) throw new ProjectResearchError("research was not negotiated"); await sink(event); },
    } });
    await adapter.initialize();
    guard();
    return adapter;
  }
}
