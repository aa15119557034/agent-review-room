import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerConfig, validateProfiles } from "./config";
import { lanAddresses } from "./net-info";

/**
 * 一键准备执行节点：
 * 1. 没有配置文件就从示例复制一份
 * 2. 没有 Token 就生成一个（已有的不会覆盖）
 * 3. 创建各 profile 的工作目录（Reviewer 用的空文件夹）
 * 4. 检查命令能不能找到，打印要填到主控端的信息
 */
const here = dirname(fileURLToPath(import.meta.url));
const appDir = resolve(here, "..");
const configPath = resolve(process.env["AGENT_SERVER_CONFIG"] ?? resolve(appDir, "agent-server.config.json"));
/**
 * --local：主控机本机用的节点（S-10），只监听 127.0.0.1，带 codex-discuss / deepseek-discuss。
 * 不带参数：Reviewer 电脑用的节点（Phase 0），监听局域网，带 claude-review。
 */
const local = process.argv.includes("--local");
const examplePath = resolve(appDir, local ? "agent-server.config.local.example.json" : "agent-server.config.example.json");

if (!existsSync(configPath)) {
  copyFileSync(examplePath, configPath);
  console.log(`已创建配置文件（${local ? "主控机本机" : "Reviewer 电脑"}）：${configPath}`);
} else {
  console.log(`使用已有配置文件：${configPath}`);
}

const config = ServerConfig.parse(JSON.parse(readFileSync(configPath, "utf8")));
const baseDir = dirname(configPath);

const tokenPath = resolve(baseDir, config.tokenFile);
let token: string;
if (existsSync(tokenPath)) {
  token = readFileSync(tokenPath, "utf8").trim();
  console.log(`使用已有 Token：${tokenPath}`);
} else {
  token = randomBytes(32).toString("hex");
  writeFileSync(tokenPath, token + "\n", { encoding: "utf8", mode: 0o600 });
  console.log(`已生成 Token：${tokenPath}`);
}

for (const p of Object.values(config.profiles)) {
  if (!isAbsolute(p.cwd)) p.cwd = resolve(baseDir, p.cwd);
  if (!existsSync(p.cwd)) {
    mkdirSync(p.cwd, { recursive: true });
    console.log(`已创建工作目录：${p.cwd}`);
  }
}

const problems = validateProfiles(config);
console.log("");
if (problems.length) {
  console.log("⚠ 还有需要处理的问题：");
  for (const p of problems) console.log(`  - ${p}`);
  console.log("");
}

// 密钥只检查有没有，不打印
const needsDeepSeekKey = Object.values(config.profiles).some((p) => p.envAllowlist.includes("DEEPSEEK_API_KEY"));
if (needsDeepSeekKey && !process.env["DEEPSEEK_API_KEY"]) {
  console.log("⚠ 没有找到环境变量 DEEPSEEK_API_KEY：deepseek-discuss 会失败。设置方法见 README「主控机本机节点」。");
  console.log("");
}

console.log("在主控端的设置页填写：");
const loopback = config.host === "127.0.0.1" || config.host === "localhost";
const addresses = loopback ? ["127.0.0.1"] : lanAddresses();
for (const ip of addresses) console.log(`  地址：http://${ip}:${config.port}`);
const ids = Object.keys(config.profiles).filter((k) => k !== "echo");
console.log(`  ${ids.length > 1 ? "可用的方式" : "评审方式"}：${ids.join("、") || Object.keys(config.profiles)[0]}`);
console.log(`  Token：${token}`);
console.log("");
console.log("然后启动：pnpm --filter @room/agent-server run start");
