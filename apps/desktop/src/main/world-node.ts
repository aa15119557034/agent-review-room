import type { RemoteAgentAdapter } from "@room/core";
import { HttpRemoteAgentAdapter } from "@room/remote-client";
import { ChatModelUnavailableError, chatRunModel, selectChatModel } from "./chat-model";
import type { Repository } from "./repository";
import type { SettingsStore } from "./settings";

interface WorldNodeDeps {
  repo: Pick<Repository, "listAgents" | "getNodeRow">;
  settings: Pick<SettingsStore, "getNode">;
  makeAdapter?: (options: ConstructorParameters<typeof HttpRemoteAgentAdapter>[0]) => RemoteAgentAdapter;
}

/** Main-only resolution: never borrow the discussion profile or another resident's credentials. */
function targetOf(deps: WorldNodeDeps, id: string) {
  const agent = deps.repo.listAgents().find((value) => value.id === id);
  // The node validates *-chat profiles as tool-free. This naming rule is not a
  // substitute for the node's isolation acceptance test (including hooks).
  if (!agent || agent.pausedByUser || agent.nodeId === null || agent.chatProfileId === null || !agent.chatProfileId.endsWith("-chat")) return null;
  const node = deps.repo.getNodeRow(agent.nodeId);
  const credential = deps.settings.getNode(agent.nodeId);
  if (!node || node.base_url === null || credential === null || node.base_url !== credential.baseUrl) return null;
  return { agent, nodeId: agent.nodeId, profileId: agent.chatProfileId, baseUrl: credential.baseUrl, token: credential.token };
}

export function worldNodeConfigured(deps: WorldNodeDeps, id: string): boolean { return targetOf(deps, id) !== null; }

/** Returns an uninitialized adapter; the cognition runner owns its session and Run lifecycle. */
export async function resolveWorldNode(deps: WorldNodeDeps, id: string, signal: AbortSignal): Promise<RemoteAgentAdapter | null> {
  const target = targetOf(deps, id);
  if (signal.aborted || target === null) return null;
  const make = deps.makeAdapter ?? ((options) => new HttpRemoteAgentAdapter(options));
  const options = {
    nodeId: target.nodeId, profileId: target.profileId, baseUrl: target.baseUrl, token: target.token,
    heartbeatTimeoutMs: 15_000, reconnectGraceMs: 30_000, requestTimeoutMs: 5_000,
  };
  const health = await make(options).health(signal);
  // Changes during the probe invalidate this attempt; do not send the old
  // credential/profile after a user pauses or reconfigures this resident.
  if (signal.aborted || JSON.stringify(targetOf(deps, id)) !== JSON.stringify(target) || !health.profiles.includes(target.profileId)) return null;
  try {
    const model = chatRunModel(selectChatModel(target.agent, target.profileId, health.profileModels, "chat"));
    return make({ ...options, ...(model === undefined ? {} : { model }) });
  } catch (error) {
    if (error instanceof ChatModelUnavailableError) return null;
    throw error;
  }
}
