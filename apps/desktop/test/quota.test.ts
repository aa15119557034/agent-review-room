import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { QuotaService, quotaKeyOf } from "../src/main/quota";

/**
 * D-32：节点额度读取（C-36 的端点）。
 * - 读到 ok / exhausted 都按 quotaState；读不到（非 200、网络错、形状不对）一律 unknown（不是用完）
 * - 记「上次读到 ok 的时间」给粘滞缺席用；unknown 不清
 * - 30 秒缓存，force 可以跳过
 */

const TARGET = { baseUrl: "http://127.0.0.1:7420/", token: "t".repeat(40), profileId: "deepseek-discuss" };

const okBody = (usedPercent: number) => ({
  fiveHour: { usedPercent, windowMinutes: 300, resetsAt: null },
  weekly: null,
  creditsInUse: null,
  readAt: "2026-11-02T00:00:00.000Z",
});

function serviceWith(responses: (() => Response | Promise<Response>)[], now?: () => number): QuotaService {
  let index = 0;
  return new QuotaService({
    fetch: async () => {
      const next = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return next();
    },
    ...(now === undefined ? {} : { now }),
  });
}

describe("QuotaService（D-32）", () => {
  it("ok / exhausted / 读不到 分别映射成三种状态", async () => {
    const ok = await serviceWith([() => new Response(JSON.stringify(okBody(12)), { status: 200 })]).read(TARGET);
    assert.equal(ok.state, "ok");
    assert.equal(ok.quota?.fiveHour?.usedPercent, 12);

    const exhausted = await serviceWith([() => new Response(JSON.stringify(okBody(100)), { status: 200 })]).read(TARGET);
    assert.equal(exhausted.state, "exhausted");

    const down = await serviceWith([() => new Response("boom", { status: 503 })]).read(TARGET);
    assert.equal(down.state, "unknown");
    assert.equal(down.quota, null);

    const broken = await serviceWith([() => new Response(JSON.stringify({ nope: true }), { status: 200 })]).read(TARGET);
    assert.equal(broken.state, "unknown");

    const network = await serviceWith([
      () => {
        throw new Error("ECONNREFUSED");
      },
    ]).read(TARGET);
    assert.equal(network.state, "unknown");
  });

  it("只有读到 ok 才刷新 lastOkAt；unknown / exhausted 不动", async () => {
    const service = serviceWith([
      () => new Response(JSON.stringify(okBody(10)), { status: 200 }),
      () => new Response("boom", { status: 503 }),
      () => new Response(JSON.stringify(okBody(100)), { status: 200 }),
    ]);
    const key = quotaKeyOf(TARGET);

    await service.read(TARGET);
    const first = service.lastOkAt(key);
    assert.ok(first > 0, "读到 ok 记时间");

    await service.read(TARGET, { force: true });
    assert.equal(service.lastOkAt(key), first, "unknown 不刷新");

    await service.read(TARGET, { force: true });
    assert.equal(service.lastOkAt(key), first, "exhausted 不刷新");
  });

  it("30 秒内走缓存；force 才重新读", async () => {
    let calls = 0;
    let clock = 1_000_000;
    const service = new QuotaService({
      now: () => clock,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify(okBody(20)), { status: 200 });
      },
    });
    await service.read(TARGET);
    await service.read(TARGET);
    assert.equal(calls, 1, "第二次命中缓存");
    clock += 31_000;
    await service.read(TARGET);
    assert.equal(calls, 2, "过期后重新读");
    await service.read(TARGET, { force: true });
    assert.equal(calls, 3, "force 跳过缓存");
  });
});
