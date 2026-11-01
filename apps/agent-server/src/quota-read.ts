import { loadConfig } from "./config";
import { readCodexQuota } from "./quota";

/**
 * S-24 实测工具：按节点配置读一次某个 profile 的订阅额度，打印一行 JSON（和 quota 端点返回的一样）。
 * 用法：pnpm --filter @room/agent-server run quota -- <profile>
 * 用途：和 Codex 自己显示的百分比对照；画一张图前后各读一次，算单图消耗。不用先启动节点
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const profileId = args[0];
  if (!profileId || args.length > 1) {
    console.error("用法：pnpm --filter @room/agent-server run quota -- <profile>");
    process.exit(2);
  }
  const { config } = loadConfig();
  const profile = Object.hasOwn(config.profiles, profileId) ? config.profiles[profileId] : undefined;
  if (!profile) {
    console.error(`没有这个 profile：${profileId}。可用的：${Object.keys(config.profiles).join("、")}`);
    process.exit(2);
  }
  if (!profile.quota) {
    console.error(`profile ${profileId} 没配 quota，读不了额度`);
    process.exit(2);
  }
  const t0 = Date.now();
  const q = await readCodexQuota(profile, { log: (m) => console.error(m) });
  console.log(JSON.stringify({ test: "S-24 quota", profileId, tookMs: Date.now() - t0, ...q }));
  process.exit(q.fiveHour && q.weekly && q.creditsInUse !== null ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
