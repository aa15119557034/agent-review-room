import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { getVoiceRecording, insertVoiceRecording, markVoiceReady, openDatabase, ulid, WriteQueue } from "@room/db";
import type { ControlEvent, VoiceRecording } from "@room/schemas";
import { VoiceService } from "../src/main/voice";
import { createAudioProtocolHandler, sniffVoiceFormat, VoiceRejectedError, VoiceStore } from "../src/main/voice-store";
import { SidecarTranscriber, type Transcriber } from "../src/main/voice-transcriber";

const dirs: string[] = [];
after(() => {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // Windows 句柄延迟
    }
  }
});

const T = "2026-11-01T00:00:00.000Z";

/** 最小可用的 wav / webm / ogg 头（sniff 只看 magic；时长是假 transcriber 给的） */
const wav = (padding = 64) => {
  const body = Buffer.alloc(padding);
  const head = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1")]);
  return Buffer.concat([head, body]);
};
const webm = (padding = 64) =>
  Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(padding)]);
const ogg = (padding = 64) => Buffer.concat([Buffer.from("OggS", "latin1"), Buffer.alloc(padding)]);

interface FakeTranscriber extends Transcriber {
  probes: string[];
  transcriptions: string[];
  failWith?: Error;
  text?: string;
}

function fakeTranscriber(options: { durationMs?: number; text?: string } = {}): FakeTranscriber {
  const state: FakeTranscriber = {
    probes: [],
    transcriptions: [],
    async probe(path) {
      state.probes.push(path);
      return options.durationMs ?? 1500;
    },
    async transcribe(path) {
      state.transcriptions.push(path);
      if (state.failWith) throw state.failWith;
      return { text: state.text ?? options.text ?? "你好，今天辛苦了。", language: "zh", durationMs: options.durationMs ?? 1500 };
    },
    dispose() {},
  };
  return state;
}

function makeHarness(transcriber: Transcriber | null = fakeTranscriber()) {
  const root = mkdtempSync(join(tmpdir(), "room-voice-"));
  dirs.push(root);
  const db = openDatabase(join(root, "room.db"));
  const queue = new WriteQueue();
  const events: ControlEvent[] = [];
  const store = new VoiceStore(db, join(root, "audio"), async (path) => {
    if (transcriber === null) throw new Error("no transcriber");
    return transcriber.probe(path);
  }, () => T);
  const service = new VoiceService({
    db,
    store,
    transcriber,
    emit: (event) => events.push(event),
    now: () => T,
  });
  return { db, queue, store, service, events, transcriber };
}

const until = async (check: () => boolean, ms = 3000): Promise<void> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("until timeout");
};

describe("voice store (D-34b)", () => {
  it("sniffs wav / webm / ogg and rejects unknown bytes", () => {
    assert.equal(sniffVoiceFormat(wav()), "wav");
    assert.equal(sniffVoiceFormat(webm()), "webm");
    assert.equal(sniffVoiceFormat(ogg()), "ogg");
    assert.equal(sniffVoiceFormat(Buffer.from("not audio at all")), null);
    assert.equal(sniffVoiceFormat(Buffer.alloc(0)), null);
  });

  it("stores a recording once per sha256, asks the sidecar for the duration", async () => {
    const h = makeHarness();
    try {
      const first = await h.store.add({ format: "wav", bytes: wav() });
      assert.equal(first.created, true);
      assert.equal(first.recording.status, "transcribing");
      assert.equal(first.recording.durationMs, 1500);
      assert.ok(existsSync(first.file));
      assert.equal(readdirSync(join(first.file, "..")).length, 1);

      const again = await h.store.add({ format: "wav", bytes: wav() });
      assert.equal(again.created, false);
      assert.equal(again.recording.audio, first.recording.audio, "same bytes, same recording");
    } finally {
      h.db.close();
    }
  });

  it("rejects empty / oversize / wrong-format / too-long recordings", async () => {
    const h = makeHarness(fakeTranscriber({ durationMs: 5 * 60_000 + 1 }));
    try {
      await assert.rejects(() => h.store.add({ format: "wav", bytes: Buffer.alloc(0) }), (e: unknown) => (e as VoiceRejectedError).code === "empty_file");
      await assert.rejects(
        () => h.store.add({ format: "wav", bytes: Buffer.concat([wav(), Buffer.alloc(17 * 1024 * 1024)]) }),
        (e: unknown) => (e as VoiceRejectedError).code === "too_big",
      );
      await assert.rejects(() => h.store.add({ format: "wav", bytes: Buffer.from("not audio") }), (e: unknown) => (e as VoiceRejectedError).code === "unsupported_type");
      await assert.rejects(() => h.store.add({ format: "wav", bytes: webm() }), (e: unknown) => (e as VoiceRejectedError).code === "unsupported_type");
      await assert.rejects(() => h.store.add({ format: "wav", bytes: wav() }), (e: unknown) => (e as VoiceRejectedError).code === "too_long");
      // 太长的录音不留下字节
      assert.equal(readdirSync(join(h.db.name, "..", "audio")).length, 0);
    } finally {
      h.db.close();
    }
  });

  it("serves room-audio:// for known refs only, and normalises the lowercased host", async () => {
    const h = makeHarness();
    try {
      const added = await h.store.add({ format: "ogg", bytes: ogg() });
      const handler = createAudioProtocolHandler(h.store);
      const lower = added.recording.audio.toLowerCase();
      const ok = await handler(new Request(`room-audio://${lower}`));
      assert.equal(ok.status, 200);
      assert.equal(ok.headers.get("content-type"), "audio/ogg");
      assert.deepEqual(Buffer.from(await ok.arrayBuffer()), ogg());

      assert.equal((await handler(new Request(`room-audio://aud_${"0".repeat(26)}`))).status, 404);
      assert.equal((await handler(new Request(`room-audio://${lower}/x`))).status, 404);
    } finally {
      h.db.close();
    }
  });
});

describe("voice service (D-34b)", () => {
  it("imports, transcribes in the background, and emits chat.voice.updated", async () => {
    const h = makeHarness();
    try {
      const recording = await h.service.import({
        type: "chat.voice.import",
        format: "wav",
        data: wav().toString("base64"),
      });
      assert.equal(recording.status, "transcribing");
      await until(() => getVoiceRecording(h.db, recording.audio)?.status === "ready");
      const ready = getVoiceRecording(h.db, recording.audio) as VoiceRecording;
      assert.equal(ready.transcript?.text, "你好，今天辛苦了。");
      assert.equal(ready.transcript?.source, "transcribed");
      assert.deepEqual(ready.transcript?.engine, { engine: "faster-whisper", model: "faster-whisper" });
      const events = h.events.filter((e) => e.type === "chat.voice.updated");
      assert.equal(events.length, 1);
      assert.equal((events[0] as Extract<ControlEvent, { type: "chat.voice.updated" }>).recording.status, "ready");
    } finally {
      h.db.close();
    }
  });

  it("marks a recording failed when the sidecar fails or hears nothing", async () => {
    const failing = fakeTranscriber();
    failing.failWith = new Error("模型加载失败");
    const h = makeHarness(failing);
    try {
      const recording = await h.service.import({ type: "chat.voice.import", format: "webm", data: webm().toString("base64") });
      await until(() => getVoiceRecording(h.db, recording.audio)?.status === "failed");
      assert.equal(getVoiceRecording(h.db, recording.audio)?.error, "模型加载失败");

      const silent = fakeTranscriber({ text: "   " });
      const h2 = makeHarness(silent);
      try {
        const second = await h2.service.import({ type: "chat.voice.import", format: "wav", data: wav().toString("base64") });
        await until(() => getVoiceRecording(h2.db, second.audio)?.status === "failed");
        assert.match(getVoiceRecording(h2.db, second.audio)?.error ?? "", /没听到说话/);
      } finally {
        h2.db.close();
      }
    } finally {
      h.db.close();
    }
  });

  it("refuses to import when the sidecar is not configured, and repairs stale transcribing on start", async () => {
    const h = makeHarness(null);
    try {
      await assert.rejects(
        () => h.service.import({ type: "chat.voice.import", format: "wav", data: wav().toString("base64") }),
        (error: unknown) => (error as { code?: string }).code === "validation_failed",
      );

      const audio = `aud_${ulid()}`;
      insertVoiceRecording(h.db, {
        recording: { audio, durationMs: 1000, status: "transcribing", transcript: null, error: null, createdAt: T } as VoiceRecording,
        sha256: "a".repeat(64),
        mime: "audio/wav",
        bytes: 100,
      });
      assert.equal(h.service.repairInterrupted(), 1);
      const repaired = getVoiceRecording(h.db, audio);
      assert.equal(repaired?.status, "failed");
      assert.equal(repaired?.error, "应用重启，转写中断");
    } finally {
      h.db.close();
    }
  });

  it("returns an existing ready recording by ref", async () => {
    const h = makeHarness();
    try {
      const audio = `aud_${ulid()}`;
      insertVoiceRecording(h.db, {
        recording: { audio, durationMs: 1000, status: "transcribing", transcript: null, error: null, createdAt: T } as VoiceRecording,
        sha256: "b".repeat(64),
        mime: "audio/wav",
        bytes: 100,
      });
      markVoiceReady(h.db, audio, { text: "转好了", language: "zh", source: "transcribed", engine: { engine: "faster-whisper", model: "small" } });
      const got = h.service.get({ type: "chat.voice.get", audio });
      assert.equal(got.status, "ready");
      assert.equal(got.transcript?.text, "转好了");
    } finally {
      h.db.close();
    }
  });
});

describe("python sidecar protocol (D-34b)", () => {
  it("talks JSON lines with the sidecar: probe, transcribe, error", async () => {
    const root = mkdtempSync(join(tmpdir(), "room-voice-sidecar-"));
    dirs.push(root);
    const script = join(root, "fake-sidecar.mjs");
    writeFileSync(
      script,
      `
let buf = "";
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.cmd === "probe") console.log(JSON.stringify({ id: req.id, ok: true, durationMs: 2500 }));
    else if (req.path === "boom") console.log(JSON.stringify({ id: req.id, ok: false, error: "读不了这个文件" }));
    else console.log(JSON.stringify({ id: req.id, ok: true, text: " 我听到了 ", language: "zh", durationMs: 2500 }));
  }
});
`,
      "utf8",
    );
    const transcriber = new SidecarTranscriber({
      python: process.execPath,
      script,
      modelDir: root,
      modelName: "fake-model",
      transcribeTimeoutMs: 5000,
      idleMs: 60_000,
    });
    try {
      assert.equal(await transcriber.probe("x.wav"), 2500);
      const result = await transcriber.transcribe("x.wav");
      assert.equal(result.text, "我听到了");
      assert.equal(result.language, "zh");
      await assert.rejects(() => transcriber.transcribe("boom"), /读不了这个文件/);
    } finally {
      transcriber.dispose();
    }
  });
});
