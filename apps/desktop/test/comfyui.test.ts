import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import sharp from "sharp";
import { ComfyUiClient, ComfyUiError, loadComfyUiConfigFile } from "../src/main/comfyui";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 上句柄释放有延迟
    }
  }
});

const pngBytes = () =>
  sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
    .png()
    .toBuffer();

const workflow = {
  "3": { class_type: "KSampler", inputs: { seed: 0, steps: 20 } },
  "5": { class_type: "EmptyLatentImage", inputs: { width: 512, height: 512 } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "" } },
  "9": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "qwen-image.safetensors" } },
};

const mapping = {
  prompt: { node: "6", field: "text" },
  width: { node: "5", field: "width" },
  height: { node: "5", field: "height" },
  seed: { node: "3", field: "seed" },
};

interface FakeServer {
  fetch: typeof fetch;
  promptBodies: { prompt: Record<string, { inputs: Record<string, unknown> }> }[];
  interrupts: number;
  history: "pending" | "completed";
  failPrompt: boolean;
}

function fakeServer(image: Buffer): FakeServer {
  const server: FakeServer = {
    fetch: null as never,
    promptBodies: [],
    interrupts: 0,
    history: "completed",
    failPrompt: false,
  };
  server.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    if (url.pathname === "/system_stats") return new Response("{}", { status: 200 });
    if (url.pathname === "/prompt") {
      if (server.failPrompt) return new Response("boom", { status: 500 });
      server.promptBodies.push(JSON.parse(String(init?.body)) as never);
      return new Response(JSON.stringify({ prompt_id: "p1" }), { status: 200 });
    }
    if (url.pathname === "/interrupt") {
      server.interrupts += 1;
      return new Response("", { status: 200 });
    }
    if (url.pathname === "/history/p1") {
      const body =
        server.history === "pending"
          ? {}
          : {
              p1: {
                status: { completed: true, status_str: "success" },
                outputs: { "9": { images: [{ filename: "out.png", subfolder: "room", type: "output" }] } },
              },
            };
      return new Response(JSON.stringify(body), { status: 200 });
    }
    if (url.pathname === "/view") return new Response(image, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return server;
}

const client = (server: FakeServer, patch: Record<string, unknown> = {}) =>
  new ComfyUiClient(
    { baseUrl: "http://127.0.0.1:8188", workflow, mapping, pollIntervalMs: 5, totalTimeoutMs: 2000, ...patch } as never,
    server.fetch,
  );

describe("ComfyUI client (D-38a)", () => {
  it("fills the four mapped fields, runs the prompt, and returns the image", async () => {
    const image = await pngBytes();
    const server = fakeServer(image);
    const c = client(server);
    assert.equal(await c.isUp(), true);

    const result = await c.draw({ prompt: "小鲸鱼", size: "1024x1536", seed: 7 });
    assert.ok(result.image.equals(image));
    assert.equal(result.seed, 7);
    assert.equal(result.model, "qwen-image.safetensors");

    const sent = server.promptBodies[0]?.prompt ?? {};
    assert.equal(sent["6"]?.inputs.text, "小鲸鱼");
    assert.equal(sent["5"]?.inputs.width, 1024);
    assert.equal(sent["5"]?.inputs.height, 1536);
    assert.equal(sent["3"]?.inputs.seed, 7);
    // 其余字段保持工作流里的值
    assert.equal(sent["3"]?.inputs.steps, 20);
  });

  it("surfaces unavailable / rejected / timeout errors and can interrupt", async () => {
    const image = await pngBytes();

    const down = fakeServer(image);
    down.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    assert.equal(await client(down).isUp(), false);

    const rejected = fakeServer(image);
    rejected.failPrompt = true;
    await assert.rejects(() => client(rejected).draw({ prompt: "x", size: "1024x1024", seed: 1 }), (e: unknown) => {
      return e instanceof ComfyUiError && e.code === "rejected";
    });

    const stuck = fakeServer(image);
    stuck.history = "pending";
    await assert.rejects(
      () => client(stuck, { totalTimeoutMs: 40 }).draw({ prompt: "x", size: "1024x1024", seed: 1 }),
      (e: unknown) => e instanceof ComfyUiError && e.code === "timeout",
    );

    // 正在跑的时候 interrupt：/interrupt 被调用
    const interrupted = fakeServer(image);
    interrupted.history = "pending";
    const running = client(interrupted, { totalTimeoutMs: 200 });
    const pending = running.draw({ prompt: "x", size: "1024x1024", seed: 1 }).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 30));
    await running.interrupt();
    assert.equal(interrupted.interrupts, 1);
    await pending;
  });

  it("loads the config file and returns null for missing / broken configs", () => {
    const dir = mkdtempSync(join(tmpdir(), "room-comfy-config-"));
    dirs.push(dir);
    assert.equal(loadComfyUiConfigFile(join(dir, "missing.json")), null);

    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify({ baseUrl: "http://127.0.0.1:8188", workflow, mapping }));
    const loaded = loadComfyUiConfigFile(good);
    assert.equal(loaded?.baseUrl, "http://127.0.0.1:8188");
    assert.deepEqual(loaded?.mapping, mapping);

    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ baseUrl: 1, workflow: null }));
    assert.equal(loadComfyUiConfigFile(bad), null);
  });
});
