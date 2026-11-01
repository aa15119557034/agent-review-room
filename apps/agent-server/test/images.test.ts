import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import {
  NodeHealth,
  RemoteEvent,
  attachmentImageBlock,
  attachmentImageSlotMarker,
  attachmentManifestBlock,
} from "@room/schemas";
import { ServerConfig, imageConfigProblems } from "../src/config";
import { createAgentServer, type AgentServer } from "../src/server";
import { imageStdin } from "../src/images";

/**
 * S-23：节点收图（C-42a / C-42g）和画图 Run（C-42b）。
 * 「CLI」都是 node -e 的小脚本：回显 stdin 和参数、往输出目录写一张图、或者什么都不写。
 */

const TOKEN = "t".repeat(40);
const NODE = process.execPath;
const outDir = mkdtempSync(join(tmpdir(), "s23-out-"));
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("fake png body")]);

/** 回显：第一行是参数，后面是 stdin 原样 */
const ECHO = `process.stdout.write(JSON.stringify(process.argv.slice(1))+"\\n");process.stdin.pipe(process.stdout)`;
/** 一张假 PNG，正文带标签，好区分是谁画的 */
const pngOf = (label: string) => Buffer.concat([PNG.subarray(0, 8), Buffer.from(`fake png body ${label}`)]);
/** 画图：读完 stdin 后往 argv[1]（节点给的这次 Run 的目录）写一张 png */
const DRAW = (delayMs: number, label = "") =>
  `process.stdin.resume();process.stdin.on("end",()=>setTimeout(()=>{require("fs").writeFileSync(require("path").join(process.argv[1],"img.png"),Buffer.from("${(label ? pngOf(label) : PNG).toString("base64")}","base64"));console.log("drew")},${delayMs}))`;
/** 画到一半：先写图再一直等（用来测取消后清理） */
const DRAW_AND_HANG = `require("fs").writeFileSync(require("path").join(process.argv[1],"half.png"),"x");setTimeout(()=>{},60000)`;
/** 节点替换成这次 Run 的目录 */
const OUT = "{image-output-dir}";

const model = (id: string, vision?: "yes" | "no" | "unknown") => ({
  id,
  displayName: id,
  efforts: [],
  defaultEffort: null,
  ...(vision ? { vision } : {}),
});

const cfg = ServerConfig.parse({
  nodeId: "test-node",
  port: 1,
  maxConcurrentRuns: 4,
  leaseMs: 400,
  heartbeatMs: 100,
  killGraceMs: 200,
  profiles: {
    see: {
      command: NODE,
      args: ["-e", ECHO, "--"],
      cwd: process.cwd(),
      models: [model("m-see", "yes"), model("m-blind", "no"), model("m-untested")],
      modelArgs: ["--model", "{model}"],
      images: { input: "claude-stream-json", args: ["--input-format", "stream-json"] },
    },
    "fixed-see": {
      command: NODE,
      args: ["-e", ECHO, "--"],
      cwd: process.cwd(),
      fixedModelVision: "yes",
      images: { input: "openai-content-json", args: ["--input-format", "content-json"] },
    },
    "fixed-untested": { command: NODE, args: ["-e", ECHO, "--"], cwd: process.cwd(), images: { input: "claude-stream-json" } },
    "no-delivery": { command: NODE, args: ["-e", ECHO, "--"], cwd: process.cwd(), fixedModelVision: "yes" },
    draw: { command: NODE, args: ["-e", DRAW(0), OUT], cwd: process.cwd(), imageRun: { outputDir: outDir } },
    "draw-slow": { command: NODE, args: ["-e", DRAW(300), OUT], cwd: process.cwd(), imageRun: { outputDir: outDir } },
    "draw-none": { command: NODE, args: ["-e", "process.stdin.resume()"], cwd: process.cwd(), imageRun: { outputDir: outDir } },
    "draw-hang": { command: NODE, args: ["-e", DRAW_AND_HANG, OUT], cwd: process.cwd(), imageRun: { outputDir: outDir } },
    // 两个画图 profile 共用同一个根目录（林离 #131）
    "draw-a": { command: NODE, args: ["-e", DRAW(300, "A"), OUT], cwd: process.cwd(), imageRun: { outputDir: outDir } },
    "draw-b": {
      command: NODE,
      // 走环境变量拿目录
      args: ["-e", DRAW(150, "B").replace("process.argv[1]", "process.env.ROOM_IMAGE_OUTPUT_DIR")],
      cwd: process.cwd(),
      imageRun: { outputDir: outDir },
    },
  },
});

let agent: AgentServer;
let base: string;

before(async () => {
  agent = createAgentServer(cfg, TOKEN);
  await new Promise<void>((r) => agent.server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(agent.server.address() as AddressInfo).port}`;
});
after(async () => {
  await agent.close();
  rmSync(outDir, { recursive: true, force: true });
});

const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const newRunId = () => "run_" + Array.from({ length: 26 }, () => ULID[randomInt(32)]).join("");
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const auth = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
const NONCE = "0123456789abcdef";
const SLOT = attachmentImageSlotMarker(NONCE);

const img = (index: number, bytes: Buffer) => ({
  index,
  mime: "image/png" as const,
  bytes: bytes.length,
  sha256: sha(bytes),
  data: bytes.toString("base64"),
});

/** 带图的 StartRun：清单块开头，资料区里放图片资料块（C-42g），最后是当前消息 */
function withImages(profileId: string, images: Buffer[], extra: Record<string, unknown> = {}) {
  const attachments = images.map((b, i) => img(i + 1, b));
  const content = `${attachmentManifestBlock(attachments)}<资料 ${NONCE}>历史</资料 ${NONCE}>\n${attachmentImageBlock(NONCE, images.length)}\n当前消息：图里写了什么？`;
  return {
    protocol: 1,
    runId: newRunId(),
    profileId,
    snapshot: { id: "snap_" + newRunId().slice(4), content, contentHash: sha(content) },
    limits: { idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    attachments,
    imageSlot: SLOT,
    ...extra,
  };
}

function textRun(profileId: string, extra: Record<string, unknown> = {}) {
  const content = "画一只猫，1024x1024";
  return {
    protocol: 1,
    runId: newRunId(),
    profileId,
    snapshot: { id: "snap_" + newRunId().slice(4), content, contentHash: sha(content) },
    limits: { idleTimeoutMs: 30_000, totalTimeoutMs: 60_000 },
    ...extra,
  };
}

const start = (b: unknown) => fetch(`${base}/v1/runs`, { method: "POST", headers: auth, body: JSON.stringify(b) });

async function readAll(runId: string): Promise<RemoteEvent[]> {
  const res = await fetch(`${base}/v1/runs/${runId}/events?after=-1`, { headers: auth });
  assert.equal(res.status, 200);
  return (await res.text())
    .split("\n")
    .filter(Boolean)
    .map((l) => RemoteEvent.parse(JSON.parse(l)))
    .filter((e) => e.type !== "heartbeat");
}

const stdoutOf = (es: RemoteEvent[]) => es.flatMap((e) => (e.type === "output" && e.stream === "stdout" ? [e.data] : [])).join("");
const terminalOf = (es: RemoteEvent[]) => {
  const ts = es.filter((e) => e.type === "terminal");
  assert.equal(ts.length, 1, "exactly one terminal");
  return (ts[0] as Extract<RemoteEvent, { type: "terminal" }>).result;
};
const errorOf = async (res: Response) => ({ status: res.status, error: ((await res.json()) as { error: string }).error });

const A = Buffer.from("image A bytes");
const B = Buffer.from("image B bytes!");

describe("S-23 health", () => {
  it("reports attachments / image runs and the fixed model's vision", async () => {
    const res = await fetch(`${base}/v1/health`, { headers: auth });
    const h = NodeHealth.parse(await res.json());
    assert.deepEqual(h.capabilities, { attachments: true, imageRuns: true, imageProfiles: ["draw", "draw-slow", "draw-none", "draw-hang", "draw-a", "draw-b"] });
    assert.equal(h.profileModels?.find((p) => p.profileId === "fixed-see")?.fixedModelVision, "yes");
    assert.equal(h.profileModels?.find((p) => p.profileId === "fixed-untested")?.fixedModelVision, undefined, "not tested = not reported");
    assert.equal(h.profileModels?.find((p) => p.profileId === "see")?.models.find((m) => m.id === "m-see")?.vision, "yes");
  });

  it("does not claim attachments when the body limit is below the contract minimum, or nobody can see", async () => {
    const small = createAgentServer({ ...cfg, maxBodyBytes: 16 * 1024 * 1024 }, TOKEN);
    const blind = createAgentServer(
      { ...cfg, profiles: { e: { ...cfg.profiles["fixed-untested"]! } } },
      TOKEN,
    );
    try {
      for (const [srv, why] of [[small, "16 MB"], [blind, "no model says yes"]] as const) {
        await new Promise<void>((r) => srv.server.listen(0, "127.0.0.1", () => r()));
        const url = `http://127.0.0.1:${(srv.server.address() as AddressInfo).port}/v1/health`;
        const h = NodeHealth.parse(await (await fetch(url, { headers: auth })).json());
        assert.equal(h.capabilities?.attachments, false, why);
      }
    } finally {
      await small.close();
      await blind.close();
    }
  });
});

describe("S-23 receiving images", () => {
  it("hands text before the slot, the images in order, then the rest — on stdin, with the image args, adding no text", async () => {
    const b = withImages("see", [A, B], { model: { model: "m-see", effort: null } });
    assert.equal((await start(b)).status, 202);
    const events = await readAll(b.runId);
    assert.deepEqual(terminalOf(events), { outcome: "completed", exitCode: 0 });
    const [argLine, stdin] = stdoutOf(events).split(/\n(.*)/s);
    assert.deepEqual(JSON.parse(argLine!), ["--model", "m-see", "--input-format", "stream-json"]);
    const msg = JSON.parse(stdin!) as { type: string; message: { role: string; content: Array<Record<string, unknown>> } };
    assert.equal(msg.type, "user");
    const blocks = msg.message.content;
    assert.deepEqual(
      blocks.map((x) => x["type"]),
      ["text", "image", "image", "text"],
    );
    const content = b.snapshot.content;
    const cut = content.indexOf(SLOT) + SLOT.length;
    assert.equal(blocks[0]!["text"], content.slice(0, cut), "slot stays at the end of the first part");
    assert.equal(blocks[3]!["text"], content.slice(cut));
    assert.equal((blocks[0]!["text"] as string) + (blocks[3]!["text"] as string), content, "the text is exactly the content");
    assert.deepEqual(blocks[1], { type: "image", source: { type: "base64", media_type: "image/png", data: A.toString("base64") } });
    assert.equal((blocks[2]!["source"] as { data: string }).data, B.toString("base64"));
  });

  it("text runs on an image-capable profile are untouched (no image args, raw stdin)", async () => {
    const b = textRun("see", { model: { model: "m-see", effort: null } });
    assert.equal((await start(b)).status, 202);
    const out = stdoutOf(await readAll(b.runId));
    assert.equal(out, `${JSON.stringify(["--model", "m-see"])}\n${b.snapshot.content}`);
  });

  it("openai-content-json for the repo's own script; fixed model without `model`", async () => {
    const b = withImages("fixed-see", [A]);
    assert.equal((await start(b)).status, 202);
    const [argLine, stdin] = stdoutOf(await readAll(b.runId)).split(/\n(.*)/s);
    assert.deepEqual(JSON.parse(argLine!), ["--input-format", "content-json"]);
    const parsed = JSON.parse(stdin!) as { content: Array<Record<string, unknown>> };
    assert.deepEqual(parsed.content.map((x) => x["type"]), ["text", "image_url", "text"]);
    assert.deepEqual(parsed.content[1], { type: "image_url", image_url: { url: `data:image/png;base64,${A.toString("base64")}` } });
  });

  it("refuses bytes that do not match their sha256 (hash_mismatch), before spawning", async () => {
    const b = withImages("see", [A], { model: { model: "m-see", effort: null } });
    const forged = { ...b, attachments: [{ ...b.attachments[0]!, data: Buffer.from("image Z bytes").toString("base64") }] };
    assert.deepEqual(await errorOf(await start(forged)), { status: 422, error: "hash_mismatch" });
    const list = (await (await fetch(`${base}/v1/runs`, { headers: auth })).json()) as { runId: string }[];
    assert.ok(!list.some((r) => r.runId === b.runId), "no run was created");
  });

  it("refuses images whose sha256 is not in the manifest block (hash_mismatch)", async () => {
    const b = withImages("see", [A], { model: { model: "m-see", effort: null } });
    // 换成 B：字节和自己的 sha256 一致，但 content 开头的清单写的是 A
    const swapped = { ...b, attachments: [img(1, B)] };
    assert.deepEqual(await errorOf(await start(swapped)), { status: 422, error: "hash_mismatch" });
  });

  it("refuses when this run's model has not been tested as able to see (vision_unsupported)", async () => {
    for (const m of ["m-blind", "m-untested"]) {
      const b = withImages("see", [A], { model: { model: m, effort: null } });
      assert.deepEqual(await errorOf(await start(b)), { status: 400, error: "vision_unsupported" }, m);
    }
    assert.deepEqual(await errorOf(await start(withImages("see", [A]))), { status: 400, error: "vision_unsupported" }, "model list but no model");
    assert.deepEqual(await errorOf(await start(withImages("fixed-untested", [A]))), { status: 400, error: "vision_unsupported" });
    assert.deepEqual(await errorOf(await start(withImages("no-delivery", [A]))), { status: 400, error: "vision_unsupported" }, "no images config");
  });

  it("same runId: same images = already_exists; other images or other kind = run_id_conflict", async () => {
    const b = withImages("see", [A], { model: { model: "m-see", effort: null } });
    assert.equal((await start(b)).status, 202);
    const again = await start(b);
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { status: string }).status, "already_exists");

    const other = withImages("see", [B], { model: { model: "m-see", effort: null }, runId: b.runId });
    assert.deepEqual(await errorOf(await start(other)), { status: 409, error: "run_id_conflict" });
    const noImages = { ...b, attachments: undefined, imageSlot: undefined };
    assert.deepEqual(await errorOf(await start(noImages)), { status: 409, error: "run_id_conflict" });
    assert.deepEqual(await errorOf(await start({ ...textRun("see"), runId: b.runId, kind: "image" })), { status: 409, error: "run_id_conflict" });
    await readAll(b.runId);
  });
});

describe("S-23 image runs (kind: image)", () => {
  it("only image profiles take image runs, and image profiles take nothing else (unsupported_kind)", async () => {
    assert.deepEqual(await errorOf(await start(textRun("see", { kind: "image" }))), { status: 400, error: "unsupported_kind" });
    assert.deepEqual(await errorOf(await start(textRun("draw"))), { status: 400, error: "unsupported_kind" });
    assert.deepEqual(await errorOf(await start(textRun("draw", { kind: "text" }))), { status: 400, error: "unsupported_kind" });
  });

  it("completes with the artifact, serves it by sha256 for leaseMs after fetching, and removes the run's own directory", async () => {
    const b = textRun("draw", { kind: "image" });
    assert.equal((await start(b)).status, 202);
    const result = terminalOf(await readAll(b.runId));
    assert.deepEqual(result, { outcome: "completed", exitCode: 0, artifact: { sha256: sha(PNG), mime: "image/png", bytes: PNG.length } });
    assert.deepEqual(readdirSync(outDir), [], "the run's directory is gone");

    assert.equal((await fetch(`${base}/v1/runs/${b.runId}/artifacts/${"0".repeat(64)}`, { headers: auth })).status, 404);
    const res = await fetch(`${base}/v1/runs/${b.runId}/artifacts/${sha(PNG)}`, { headers: auth });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
    assert.equal((await fetch(`${base}/v1/runs/${b.runId}/artifacts/${sha(PNG)}`)).status, 401, "needs the token");
    // 汐 #131：取过之后再留 leaseMs，断线可以重取；之后丢掉
    const again = await fetch(`${base}/v1/runs/${b.runId}/artifacts/${sha(PNG)}`, { headers: auth });
    assert.equal(again.status, 200, "a retry right after is still served");
    await again.arrayBuffer();
    await new Promise((r) => setTimeout(r, cfg.leaseMs + 200));
    assert.equal((await fetch(`${base}/v1/runs/${b.runId}/artifacts/${sha(PNG)}`, { headers: auth })).status, 404, "dropped leaseMs after the last fetch");
  });

  it("drops an artifact nobody fetched after leaseMs", async () => {
    const b = textRun("draw", { kind: "image" });
    assert.equal((await start(b)).status, 202);
    const result = terminalOf(await readAll(b.runId));
    assert.equal(result.outcome, "completed");
    await new Promise((r) => setTimeout(r, cfg.leaseMs + 200));
    assert.equal((await fetch(`${base}/v1/runs/${b.runId}/artifacts/${sha(PNG)}`, { headers: auth })).status, 404);
  });

  it("exit 0 without an image is error(incomplete_output)", async () => {
    const b = textRun("draw-none", { kind: "image" });
    assert.equal((await start(b)).status, 202);
    const result = terminalOf(await readAll(b.runId));
    assert.equal(result.outcome, "error");
    assert.equal(result.outcome === "error" && result.reason, "incomplete_output");
  });

  it("one drawing per image profile at a time (node_busy)", async () => {
    const first = textRun("draw-slow", { kind: "image" });
    assert.equal((await start(first)).status, 202);
    assert.deepEqual(await errorOf(await start(textRun("draw-slow", { kind: "image" }))), { status: 429, error: "node_busy" });
    assert.equal(terminalOf(await readAll(first.runId)).outcome, "completed");
    assert.deepEqual(readdirSync(outDir), []);
  });

  it("a cancelled drawing leaves no file behind", async () => {
    const b = textRun("draw-hang", { kind: "image" });
    assert.equal((await start(b)).status, 202);
    const events = readAll(b.runId);
    const half = join(outDir, b.runId, "half.png");
    for (let i = 0; i < 50 && !existsSync(half); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(existsSync(half), "the fake CLI wrote its half image into the run's own directory");
    await fetch(`${base}/v1/runs/${b.runId}/cancel`, { method: "POST", headers: auth, body: "{}" });
    assert.equal(terminalOf(await events).outcome, "cancelled");
    assert.deepEqual(readdirSync(outDir), []);
  });

  it("林离 #131: files other processes write or change next to the run are never taken or deleted", async () => {
    const manual = join(outDir, "manual.png");
    const old = join(outDir, "old.png");
    writeFileSync(old, pngOf("old"));
    try {
      const b = textRun("draw-slow", { kind: "image" });
      assert.equal((await start(b)).status, 202);
      // Run 期间：别人新画一张、改写一张原有的
      writeFileSync(manual, pngOf("manual, newer than the run's image"));
      const later = new Date(Date.now() + 60_000);
      utimesSync(manual, later, later); // 比这次 Run 画的图还新

      writeFileSync(old, pngOf("old, rewritten"));
      const result = terminalOf(await readAll(b.runId));
      assert.equal(result.outcome === "completed" && result.artifact?.sha256, sha(PNG), "only the run's own image");
      assert.deepEqual(readFileSync(manual), pngOf("manual, newer than the run's image"));
      assert.deepEqual(readFileSync(old), pngOf("old, rewritten"));
      assert.deepEqual(readdirSync(outDir).sort(), ["manual.png", "old.png"]);
    } finally {
      rmSync(manual, { force: true });
      rmSync(old, { force: true });
    }
  });

  it("林离 #131: two image profiles sharing a root draw at once and each gets its own image", async () => {
    const a = textRun("draw-a", { kind: "image" });
    const b = textRun("draw-b", { kind: "image" });
    assert.equal((await start(a)).status, 202);
    assert.equal((await start(b)).status, 202);
    const [ra, rb] = await Promise.all([readAll(a.runId), readAll(b.runId)]);
    const shaOf = (es: RemoteEvent[]) => {
      const t = terminalOf(es);
      return t.outcome === "completed" ? t.artifact?.sha256 : t;
    };
    assert.equal(shaOf(ra), sha(pngOf("A")));
    assert.equal(shaOf(rb), sha(pngOf("B")));
    assert.deepEqual(readdirSync(outDir), []);
  });

  it("a run directory that already exists is not taken over", async () => {
    const b = textRun("draw", { kind: "image" });
    mkdirSync(join(outDir, b.runId));
    writeFileSync(join(outDir, b.runId, "someone-else.png"), PNG);
    try {
      assert.equal((await start(b)).status, 202);
      const result = terminalOf(await readAll(b.runId));
      assert.equal(result.outcome === "error" && result.reason, "spawn_failed");
      assert.ok(existsSync(join(outDir, b.runId, "someone-else.png")), "left alone");
    } finally {
      rmSync(join(outDir, b.runId), { recursive: true, force: true });
    }
  });
});

describe("S-23 leftover run folders", () => {
  it("汐 #131: on start the node removes leftover run_<ULID> folders in its image root, and nothing else", async () => {
    const root = mkdtempSync(join(tmpdir(), "s23-sweep-"));
    const left = join(root, "run_01JAAAAAAAAAAAAAAAAAAAAAAA");
    mkdirSync(left);
    writeFileSync(join(left, "half.png"), "x");
    mkdirSync(join(root, "keep-me"));
    writeFileSync(join(root, "run_01JAAAAAAAAAAAAAAAAAAAAAAB.png"), "a file, not a folder");
    const srv = createAgentServer(
      { ...cfg, profiles: { d: { ...cfg.profiles["draw"]!, imageRun: { outputDir: root } } } },
      TOKEN,
    );
    try {
      assert.deepEqual(readdirSync(root).sort(), ["keep-me", "run_01JAAAAAAAAAAAAAAAAAAAAAAB.png"]);
    } finally {
      await srv.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("S-23 config and stdin helpers", () => {
  const base = { command: "x", cwd: "." };
  const p = (o: Record<string, unknown>) => ServerConfig.parse({ nodeId: "n", profiles: { a: { ...base, ...o } } }).profiles["a"]!;

  it("vision yes needs a way to hand images over; fixedModelVision only without a model list; image profiles take no images", () => {
    assert.deepEqual(imageConfigProblems(p({})), []);
    assert.match(imageConfigProblems(p({ fixedModelVision: "yes" })).join(), /没配 images/);
    assert.deepEqual(imageConfigProblems(p({ fixedModelVision: "no" })), [], "no / unknown need nothing");
    assert.match(
      imageConfigProblems(p({ models: [model("m", "yes")], modelArgs: ["--model", "{model}"], fixedModelVision: "yes", images: { input: "claude-stream-json" }, parser: "claude-stream-json" })).join(),
      /fixedModelVision/,
    );
    assert.match(imageConfigProblems(p({ images: { input: "claude-stream-json" } })).join(), /parser/);
    assert.match(imageConfigProblems(p({ images: { input: "openai-content-json" } })).join(), /room-jsonl/);
    assert.match(imageConfigProblems(p({ imageRun: { outputDir: "o" }, images: { input: "claude-stream-json" }, parser: "claude-stream-json" })).join(), /不收图/);
    assert.match(imageConfigProblems(p({ args: ["{image-output-dir}"] })).join(), /只给画图 profile/);
    assert.deepEqual(imageConfigProblems(p({ args: ["{image-output-dir}"], imageRun: { outputDir: "o" } })), []);
  });

  it("default body limit fits the contract minimum", () => {
    assert.ok(ServerConfig.parse({ nodeId: "n", profiles: {} }).maxBodyBytes >= 28 * 1024 * 1024);
  });

  it("imageStdin refuses a slot that is missing or appears twice", () => {
    const one = [{ index: 1, mime: "image/png" as const, data: "AAAA" }];
    assert.throws(() => imageStdin("claude-stream-json", "no slot here", SLOT, one));
    assert.throws(() => imageStdin("claude-stream-json", `${SLOT}${SLOT}`, SLOT, one));
    const onlySlot = JSON.parse(imageStdin("claude-stream-json", SLOT, SLOT, one)) as { message: { content: unknown[] } };
    assert.equal(onlySlot.message.content.length, 2, "no empty text block after the slot");
  });
});

describe("S-23 vision-test helpers", () => {
  it("the test image is a valid PNG of the code; the request is a legal StartRun with the slot in the materials", async () => {
    const { renderCodePng, randomCode, visionTestRequest, answerPasses } = await import("../src/vision-test");
    const { StartRunRequest } = await import("@room/schemas");
    const { inflateSync } = await import("node:zlib");
    const code = randomCode();
    assert.match(code, /^\d{6}$/);
    const png = renderCodePng(code, 4);
    assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    const idatLen = png.readUInt32BE(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    assert.equal(raw.length, (width + 1) * height);
    assert.ok(raw.includes(0x00) && raw.includes(0xff), "black digits on white");

    const req = visionTestRequest("claude-chat", png, { model: "m" as never, effort: null });
    assert.ok(StartRunRequest.safeParse(req).success);
    assert.ok(!req.snapshot.content.includes(code), "the code is only in the image");
    const slotAt = req.snapshot.content.indexOf(req.imageSlot!);
    assert.ok(slotAt < req.snapshot.content.indexOf("当前消息"), "images come before the current message");

    assert.ok(answerPasses(` ${code.slice(0, 3)} ${code.slice(3)}\n`, code));
    assert.ok(!answerPasses("看不到", code));
    assert.ok(!answerPasses(`1${code}`, code), "an extra digit is a misread");
    assert.ok(!answerPasses(code.slice(1), code));
  });
});
