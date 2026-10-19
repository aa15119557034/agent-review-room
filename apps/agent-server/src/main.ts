import { loadConfig } from "./config";
import { createAgentServer } from "./server";

const { config, token } = loadConfig();
const agent = createAgentServer(config, token);

agent.server.listen(config.port, config.host, () => {
  console.log(`[agent-server] node "${config.nodeId}" listening on http://${config.host}:${config.port}`);
  if (config.host !== "127.0.0.1" && config.host !== "::1") {
    console.warn("[agent-server] WARNING: plain HTTP on a network interface. Use TLS or a VPN tunnel (WireGuard/Tailscale).");
  }
});

// 正常关闭时终止所有子进程。被 SIGKILL / 崩溃时做不到——见 README「已知缺口」
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.once(sig, () => {
    console.log(`[agent-server] ${sig}, shutting down`);
    void agent.close().then(() => process.exit(0));
  });
}
