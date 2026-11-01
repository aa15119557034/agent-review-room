import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  currentVersion,
  findSpeechClip,
  getSpeechClip,
  getSpeechClipByAudioRef,
  insertAudioRef,
  insertSpeechClip,
  LATEST_SCHEMA_VERSION,
  openDatabase,
} from "../src/index";
import type { SpeechClip } from "@room/schemas";

/**
 * v16 / D-37b：语音片段与音频引用。
 * - 缓存键（文本 hash + 声音 + 语速 + 引擎 + 版本）唯一
 * - 片段和音频引用都不可变；外键指向 audio_refs
 */

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

const sha = (seed: string) => seed.repeat(64).slice(0, 64);
const AUDIO = "aud_" + "0123456789ABCDEFGHJKMNPQRSTV".slice(0, 26);

async function env() {
  const dir = mkdtempSync(join(tmpdir(), "room-speech-clip-"));
  dirs.push(dir);
  const db = openDatabase(join(dir, "room.db"));
  insertAudioRef(db, { ref: AUDIO as never, sha256: sha("a"), mime: "audio/wav", bytes: 2048, createdAt: "2026-11-02T00:00:00.000Z" });
  return db;
}

const clip = (overrides: Partial<SpeechClip> = {}): SpeechClip => ({
  id: ("spch_" + "0123456789ABCDEFGHJKMNPQRSTV".slice(0, 26)) as SpeechClip["id"],
  textHash: sha("b"),
  voiceId: "xiaoyu" as SpeechClip["voiceId"],
  speed: 1,
  engine: "indextts2",
  engineVersion: "indextts2-2.0.0",
  audioRef: AUDIO as SpeechClip["audioRef"],
  mime: "audio/wav",
  durationMs: 7640,
  createdAt: "2026-11-02T00:00:00.000Z",
  ...overrides,
});

describe("speech clips (v16 / D-37b)", () => {
  it("stores a clip and finds it by the cache key and by audio ref", async () => {
    const db = await env();
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      const stored = clip();
      insertSpeechClip(db, stored);
      assert.deepEqual(getSpeechClip(db, stored.id), stored);
      assert.deepEqual(
        findSpeechClip(db, {
          textHash: stored.textHash,
          voiceId: stored.voiceId,
          speed: stored.speed,
          engine: stored.engine,
          engineVersion: stored.engineVersion,
        }),
        stored,
      );
      assert.equal(getSpeechClipByAudioRef(db, stored.audioRef)?.id, stored.id);
      // 语速变了就不命中（语速在合成时生效）
      assert.equal(
        findSpeechClip(db, {
          textHash: stored.textHash,
          voiceId: stored.voiceId,
          speed: 1.5,
          engine: stored.engine,
          engineVersion: stored.engineVersion,
        }),
        null,
      );
    } finally {
      db.close();
    }
  });

  it("rejects a second clip with the same cache key, a dangling audio ref, and any update", async () => {
    const db = await env();
    try {
      const stored = clip();
      insertSpeechClip(db, stored);
      assert.throws(
        () => insertSpeechClip(db, clip({ id: ("spch_" + "Z".repeat(26)) as SpeechClip["id"] })),
        /UNIQUE/,
      );
      assert.throws(
        () => insertSpeechClip(db, clip({ id: "spch_" + "Y".repeat(26) as never, textHash: sha("c"), audioRef: ("aud_" + "Z".repeat(26)) as never })),
        /FOREIGN KEY/,
      );
      assert.throws(() => db.prepare("UPDATE speech_clips SET duration_ms = 1 WHERE id = ?").run(stored.id), /immutable/);
      assert.throws(() => db.prepare("UPDATE audio_refs SET bytes = 1 WHERE ref = ?").run(AUDIO), /immutable/);
    } finally {
      db.close();
    }
  });
});
