import { chatProfileWarnings, loadConfig, validateProfiles } from "./config";
import { selectMemory } from "./memory-folder";
import { identityProblems, memoryDirOf } from "./node-identity";
import { lanAddresses } from "./net-info";
import { createAgentServer } from "./server";

let loaded;
try {
  loaded = loadConfig();
} catch (err) {
  console.error(`[agent-server] 启动失败：${(err as Error).message}`);
  process.exit(1);
}
const { config, token, configPath } = loaded;

const problems = [...validateProfiles(config), ...identityProblems(config)];
if (problems.length) {
  console.error(`[agent-server] 配置有问题（${configPath}）：`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

// 不拦启动的提醒（C-49）
for (const [id, p] of Object.entries(config.profiles)) {
  for (const w of chatProfileWarnings(id, p)) console.warn(`[agent-server] 提醒（profile "${id}"）：${w}`);
}

// S-20：启动时按规则读一遍记忆，只报结果，不打印正文。不合格时 health 不报 memoryProfiles，
// 聊天 Run 的槽位里换成「此记忆来源不可用」（不让聊天失败）
if (Object.values(config.profiles).some((p) => p.memory)) {
  const sel = selectMemory(memoryDirOf(config));
  if (sel.status === "unavailable") console.warn(`[agent-server] 记忆不可用：${sel.reason}`);
  else console.log(`[agent-server] 记忆可用：${sel.entries.length} 条`);
  for (const w of sel.warnings) console.warn(`[agent-server] 记忆：${w}`);
}

const agent = createAgentServer(config, token);

agent.server.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EADDRINUSE") console.error(`[agent-server] 端口 ${config.port} 已被占用。改配置里的 port，或关掉占用它的程序。`);
  else console.error(`[agent-server] 无法监听：${err.message}`);
  process.exit(1);
});

agent.server.listen(config.port, config.host, () => {
  console.log(`[agent-server] 节点 "${config.nodeId}" 已启动，监听 ${config.host}:${config.port}`);
  console.log(`[agent-server] 可用的评审方式：${Object.keys(config.profiles).join("、")}`);
  if (config.host === "0.0.0.0" || config.host === "::") {
    const ips = lanAddresses();
    if (ips.length) {
      console.log("[agent-server] 在主控端的设置页填写以下任一地址：");
      for (const ip of ips) console.log(`    http://${ip}:${config.port}`);
    }
    console.log("[agent-server] 第一次运行时 Windows 可能弹出防火墙提示，请允许“专用网络”。");
    console.log("[agent-server] 注意：局域网内是明文 HTTP，Token 只适合在可信的家庭 / 办公网络里使用。");
  }
});

// 正常关闭时终止所有子进程（Windows 上 Ctrl+C 也会走这里）
for (const sig of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
  process.once(sig, () => {
    console.log(`[agent-server] 收到 ${sig}，正在停止所有评审…`);
    void agent.close().then(() => process.exit(0));
  });
}
