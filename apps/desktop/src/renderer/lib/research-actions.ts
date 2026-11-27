import type { CommandRequest, ProjectResearchPreview, ProjectSourcesCurrent, QueryResponse } from "@room/schemas";
import { applyEvent, type AppState } from "./state";
import { ControlFailure, type RoomClient } from "./client";
import type { Store } from "./store";

export function createResearchActions(store: Store<AppState>, client: RoomClient, fail: (error: unknown) => void, projectEpoch: () => number) {
  const inFlight = new Set<string>();
  const scoped = async <T>(projectId: string, operation: (valid: () => boolean) => Promise<T>, source = false): Promise<T | undefined> => {
    const epoch = projectEpoch(), revision = store.get().sourceRevision;
    const valid = () => projectEpoch() === epoch && store.get().currentProjectId === projectId && (!source || store.get().sourceRevision === revision);
    if (!valid()) return;
    try { const result = await operation(valid); return valid() ? result : undefined; }
    catch (error) { if (valid()) fail(error); return; }
  };
  return {
    choices: (projectId: string) => scoped(projectId, async () => {
      const nodes = await client.query({ type: "nodes.list" });
      return (await Promise.all(nodes.filter((node) => node.tokenConfigured).map(async (node) => {
        const result = await client.command({ type: "node.test", id: node.id, baseUrl: node.baseUrl, profileId: "research" });
        const profiles = result.reachable ? result.health.capabilities?.projectResearch?.profiles.filter((profile) => result.health.capabilities?.structuredResults?.profiles.includes(profile) && result.health.profiles.includes(profile)) ?? [] : [];
        return { node, profiles };
      }))).filter((item) => item.profiles.length > 0);
    }),
    load: (projectId: string) => scoped(projectId, async (valid) => {
      const state = store.get(), ids = [...new Set([...state.approvals.map((a) => a.snapshotId), ...state.runs.map((r) => r.snapshotId)])];
      const snapshots = await Promise.all(ids.map((snapshotId) => state.snapshots[snapshotId] ?? client.query({ type: "snapshots.get", snapshotId })));
      if (!valid()) return { previews: [], results: [] };
      store.set((s) => ({ ...s, snapshots: { ...s.snapshots, ...Object.fromEntries(snapshots.map((snapshot) => [snapshot.id, snapshot])) } }));
      const research = snapshots.filter((s) => s.adapterVersion === "project-research-v1");
      const [previews, results] = await Promise.all([
        Promise.all(research.map((snapshot) => client.query({ type: "research.preview", projectId, snapshotId: snapshot.id }))),
        Promise.all(state.runs.filter((r) => research.some((s) => s.id === r.snapshotId)).map((run) => client.query({ type: "research.result", projectId, runId: run.id }))),
      ]);
      return { previews, results };
    }),
    prepare: (input: Omit<CommandRequest<"research.prepare">, "type">) => scoped(input.projectId, async (valid) => {
      const preview = await client.command({ type: "research.prepare", ...input });
      if (valid()) store.set((s) => ({ ...applyEvent(s, { type: "approval.updated", approval: preview.approval }), snapshots: { ...s.snapshots, [preview.snapshot.id]: preview.snapshot } }));
      return preview;
    }),
    approve: (preview: ProjectResearchPreview) => scoped(preview.plan.projectId, async (valid) => {
      if (inFlight.has(preview.approval.id) || store.get().staleApprovalIds.includes(preview.approval.id)) return;
      inFlight.add(preview.approval.id);
      try {
        const result = await client.command({ type: "research.approve", approvalId: preview.approval.id, expectedSnapshotHash: preview.snapshot.contentHash, expectedResearchHash: preview.researchHash });
        if (valid()) store.set((s) => applyEvent(applyEvent(s, { type: "approval.updated", approval: result.approval }), { type: "run.updated", run: result.run }));
        return result;
      } catch (error) {
        if (valid() && error instanceof ControlFailure && error.code === "stale_snapshot") store.set((s) => ({ ...s, staleApprovalIds: [...new Set([...s.staleApprovalIds, preview.approval.id])] }));
        throw error;
      } finally { inFlight.delete(preview.approval.id); }
    }),
    currentSources: (projectId: string, owner: ProjectSourcesCurrent["owner"]) => scoped(projectId, () => client.query({ type: "sources.current", projectId, owner }), true),
    result: (projectId: string, runId: string) => scoped(projectId, () => client.query({ type: "research.result", projectId, runId })),
    previewSource: (projectId: string, owner: ProjectSourcesCurrent["owner"], index: number) => scoped(projectId, () => client.query({ type: "sources.preview", projectId, owner, index }), true),
  };
}

export type ResearchHistory = { previews: ProjectResearchPreview[]; results: QueryResponse<"research.result">[] };
