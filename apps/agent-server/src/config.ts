import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { ProfileId } from "@room/schemas";

/**
 * 节点本地配置。能跑什么命令只由这里决定，远端请求只能按 profileId 选择。
 */
const Profile = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    /** 工作目录。只读 Reviewer 应指向一个 detached worktree */
    cwd: z.string().min(1),
    /** 只把这些环境变量传给子进程 */
    envAllowlist: z.array(z.string()).default(["PATH", "HOME", "USERPROFILE", "SYSTEMROOT", "LANG"]),
    /** 额外固定注入的环境变量（不要放密钥，密钥用 envAllowlist 从节点环境透传） */
    env: z.record(z.string(), z.string()).default({}),
    /** 请求带 commitSha 时，校验 cwd 的 HEAD 一致且工作区干净 */
    verifyCommit: z.boolean().default(false),
    maxIdleTimeoutMs: z.number().int().positive().default(300_000),
    maxTotalTimeoutMs: z.number().int().positive().default(3_600_000),
  })
  .strict();

export const ServerConfig = z
  .object({
    nodeId: z.string().min(1),
    /** 默认只监听本机。要给局域网用，必须显式写局域网 IP */
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(7420),
    maxConcurrentRuns: z.number().int().positive().default(1),
    /** 没有订阅者超过这个时间就终止 run。必须小于 Orchestrator 的 reconnectGraceMs */
    leaseMs: z.number().int().positive().default(20_000),
    heartbeatMs: z.number().int().positive().default(5_000),
    /** kill 时先礼后兵：发 SIGTERM 后等多久再强杀 */
    killGraceMs: z.number().int().positive().default(5_000),
    maxBodyBytes: z.number().int().positive().default(4 * 1024 * 1024),
    /** 单个 run 缓冲的输出上限，超过就终止 */
    maxOutputBytes: z.number().int().positive().default(16 * 1024 * 1024),
    /** run 结束后在内存里保留多久，供断线的 Orchestrator 回来取终止事件 */
    finishedRunTtlMs: z.number().int().positive().default(10 * 60_000),
    profiles: z.record(ProfileId, Profile),
  })
  .strict();

export type ServerConfig = z.infer<typeof ServerConfig>;
export type Profile = z.infer<typeof Profile>;

export interface LoadedConfig {
  config: ServerConfig;
  token: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const path = env.AGENT_SERVER_CONFIG ?? "agent-server.config.json";
  const raw: unknown = JSON.parse(readFileSync(resolve(path), "utf8"));
  const config = ServerConfig.parse(raw);

  const token = env.AGENT_SERVER_TOKEN ?? "";
  if (token.length < 32) {
    throw new Error("AGENT_SERVER_TOKEN must be set and at least 32 characters long");
  }
  return { config, token };
}
