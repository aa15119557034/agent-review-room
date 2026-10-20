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
const examplePath = resolve(appDir, "agent-server.config.example.json");

if (!existsSync(configPath)) {
  copyFileSync(examplePath, configPath);
  console.log(`已创建配置文件：${configPath}`);
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

console.log("在主控端的设置页填写：");
for (const ip of lanAddresses()) console.log(`  地址：http://${ip}:${config.port}`);
console.log(`  评审方式：${Object.keys(config.profiles).find((k) => k.startsWith("claude")) ?? Object.keys(config.profiles)[0]}`);
console.log(`  Token：${token}`);
console.log("");
console.log("然后启动：pnpm --filter @room/agent-server run start");
