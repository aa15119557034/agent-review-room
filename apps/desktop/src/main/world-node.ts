import type { RemoteAgentAdapter } from "@room/core";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { NodeHealth, WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1 } from "@room/schemas";
import { ChatModelUnavailableError, chatRunModel, selectChatModel } from "./chat-model";
import type { Repository } from "./repository";
import type { SettingsStore } from "./settings";
import type { WorldBudgetStore } from "@room/db";

interface WorldNodeDeps {
  repo: Pick<Repository, "listAgents" | "getNodeRow">;
  settings: Pick<SettingsStore, "getNode">;
  makeAdapter?: (options: ConstructorParameters<typeof HttpRemoteAgentAdapter>[0]) => RemoteAgentAdapter;
}

/** Main-only resolution: never borrow the discussion profile or another resident's credentials. */
function targetOf(deps: WorldNodeDeps, id: string) {
  const agent = deps.repo.listAgents().find((value) => value.id === id);
  if (!agent || agent.pausedByUser || agent.nodeId === null || agent.chatProfileId === null) return null;
  const node = deps.repo.getNodeRow(agent.nodeId);
  const credential = deps.settings.getNode(agent.nodeId);
  if (!node || node.base_url === null || credential === null || node.base_url !== credential.baseUrl) return null;
  return { agent, nodeId: agent.nodeId, profileId: agent.chatProfileId, baseUrl: credential.baseUrl, token: credential.token };
}

export function worldNodeConfigured(deps: WorldNodeDeps, id: string): boolean { return targetOf(deps, id) !== null; }

/** Restart reconciliation uses saved identity, never the resident's current
 * profile or node. Original profile/agent deletion does not erase the Run. */
export function resolveWorldFence(deps: Pick<WorldNodeDeps, "settings" | "makeAdapter">,
  binding: NonNullable<ReturnType<WorldBudgetStore["pending"]>[number]["binding"]>) {
  const credential = deps.settings.getNode(binding.nodeId);
  if (!credential || credential.baseUrl !== binding.baseUrl) return null;
  const make = deps.makeAdapter ?? ((options) => new HttpRemoteAgentAdapter(options));
  return make({ nodeId: binding.nodeId, baseUrl: binding.baseUrl, profileId: binding.profileId, token: credential.token,
    expectedLedgerId: binding.ledgerId, expectedWorldProfile: binding.worldProfile, model: binding.model,
    heartbeatTimeoutMs: 15_000, reconnectGraceMs: 30_000, requestTimeoutMs: 5_000,
  }).runFence ?? null;
}

/** Returns an uninitialized adapter; the cognition runner owns its session and Run lifecycle. */
export async function resolveWorldNode(deps: WorldNodeDeps, id: string, signal: AbortSignal): Promise<{
  adapter: RemoteAgentAdapter;
  binding: Omit<Parameters<WorldBudgetStore["reserveBound"]>[0]["binding"], "worldId" | "generation">;
  isCurrent: () => boolean;
} | null> {
  const target = targetOf(deps, id);
  if (signal.aborted || target === null) return null;
  const make = deps.makeAdapter ?? ((options) => new HttpRemoteAgentAdapter(options));
  const options = {
    nodeId: target.nodeId, profileId: target.profileId, baseUrl: target.baseUrl, token: target.token,
    heartbeatTimeoutMs: 15_000, reconnectGraceMs: 30_000, requestTimeoutMs: 5_000,
  };
  const parsed = NodeHealth.safeParse(await make(options).health(signal));
  if (!parsed.success) return null;
  const health = parsed.data;
  // Changes during the probe invalidate this attempt; do not send the old
  // credential/profile after a user pauses or reconfigures this resident.
  if (signal.aborted || JSON.stringify(targetOf(deps, id)) !== JSON.stringify(target) || health.nodeId !== target.nodeId || !health.profiles.includes(target.profileId)) return null;
  const ledger = health.capabilities?.runFence;
  const mapping = health.capabilities?.worldProfiles?.find(p => p.sourceChatProfileId === target.profileId);
  if (!ledger || !mapping || mapping.recipeVersion !== WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1) return null;
  try {
    // Resolve the source's actual chat choice once; the target only validates it.
    const model = chatRunModel(selectChatModel(target.agent, target.profileId, health.profileModels, "chat")) ?? mapping.sourceDefaultModel;
    if (model === null) return null;
    const choice = health.profileModels?.find(p => p.profileId === mapping.profileId)?.models.find(m => m.id === model.model);
    if (!choice || (model.effort === null ? choice.efforts.length !== 0 : !choice.efforts.some(e => e.id === model.effort))) return null;
    const worldProfile = { sourceChatProfileId: target.profileId, recipeVersion: mapping.recipeVersion };
    const isCurrent = () => !signal.aborted && JSON.stringify(targetOf(deps, id)) === JSON.stringify(target);
    const adapter = make({ ...options, profileId: mapping.profileId, model, expectedLedgerId: ledger.ledgerId, expectedWorldProfile: worldProfile, isDispatchCurrent: isCurrent });
    return { adapter, binding: { nodeId: target.nodeId, baseUrl: target.baseUrl, profileId: mapping.profileId, ledgerId: ledger.ledgerId, worldProfile, model },
      isCurrent };
  } catch (error) {
    if (error instanceof ChatModelUnavailableError) return null;
    throw error;
  }
}
