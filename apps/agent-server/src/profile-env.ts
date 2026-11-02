import { readFileSync } from "node:fs";
import type { Profile } from "./config";

/**
 * 给 profile 起的子进程（Run、读 Codex 额度）和节点自己读 DeepSeek 余额共用的环境边界：
 * envAllowlist 里的变量取本进程的值，再叠 profile.env，最后叠 envFiles 现读的文件内容。
 * 读不了 / 空文件就抛错，消息里只有变量名和路径，不含内容。
 */
export function buildProfileEnv(profile: Profile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of profile.envAllowlist) {
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  // S-20：密钥从文件现读（只有这位秘书的账号能读那个文件）；读不到就抛错，调用方按 spawn_failed 结束，消息里只有路径
  const fromFiles: NodeJS.ProcessEnv = {};
  for (const [key, file] of Object.entries(profile.envFiles)) {
    let value: string;
    try {
      value = readFileSync(file, "utf8").trim();
    } catch (err) {
      throw new Error(`读不了 envFiles.${key}（${file}）：${(err as NodeJS.ErrnoException).code ?? "error"}`);
    }
    if (value === "") throw new Error(`envFiles.${key}（${file}）是空的`);
    fromFiles[key] = value;
  }
  return { ...env, ...profile.env, ...fromFiles };
}
