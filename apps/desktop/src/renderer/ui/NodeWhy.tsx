import { useState } from "react";
import type { AgentProfile } from "@room/schemas";
import { nodeWhyCheck } from "../lib/chat";
import { RECOMMENDED_NODES } from "../lib/presets";
import { useActions } from "./hooks";

/**
 * 「为什么连不上」（C-49 / B-09）：聊天和秘书页只知道「节点连不上 / 离线」，
 * 点一下用保存的地址和 Token 测一次（node.test，和设置页「测试连接」同一条命令），把原因说清楚：
 * 节点没开、Token 不对、还是 profile 不在。只读，不改任何设置。
 */
export function NodeWhy({ agent, profileId }: { agent: AgentProfile; profileId: string | null }) {
  const actions = useActions();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const nodeId = agent.nodeId;
  if (nodeId === null || profileId === null) return null;
  const label = RECOMMENDED_NODES.find((n) => n.id === nodeId)?.label ?? nodeId;

  const check = async () => {
    setBusy(true);
    setResult(null);
    // 每一步没跑成都有一句话（nodeWhyCheck）：不会出现点了没反应、按钮变回「查原因」的情况
    setResult(await nodeWhyCheck(actions, nodeId, profileId, label));
    setBusy(false);
  };

  return (
    <span className="node-why">
      <button type="button" className="button-link" disabled={busy} onClick={() => void check()}>
        {busy ? "检查中…" : result ? "再查一次" : "查原因"}
      </button>
      {result && (
        <span className="node-why-text" data-ok={result.ok} role="status">
          {result.text}
        </span>
      )}
    </span>
  );
}
