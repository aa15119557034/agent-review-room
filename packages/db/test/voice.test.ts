import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import Database from "better-sqlite3";
import {
  currentVersion,
  findVoiceRecordingBySha,
  getVoiceRecording,
  insertVoiceRecording,
  LATEST_SCHEMA_VERSION,
  listVoiceRecordings,
  markVoiceFailed,
  markVoiceReady,
  openDatabase,
  VoiceStatusConflictError,
} from "../src/index";
import type { VoiceRecording } from "@room/schemas";
import { SCHEMA_V1, SCHEMA_V2 } from "../src/schema";
import { SCHEMA_V3, SCHEMA_V3_REBUILD } from "../src/schema-v3";
import { SCHEMA_V4 } from "../src/schema-v4";
import { SCHEMA_V5 } from "../src/schema-v5";
import { SCHEMA_V6 } from "../src/schema-v6";
import { SCHEMA_V7 } from "../src/schema-v7";
import { SCHEMA_V8 } from "../src/schema-v8";
import { SCHEMA_V9 } from "../src/schema-v9";
import { SCHEMA_V10 } from "../src/schema-v10";
import { SCHEMA_V11 } from "../src/schema-v11";

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

function tempFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return join(dir, "room.db");
}

const T = "2026-10-27T00:00:00.000Z";
const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const AUDIO = `aud_${ID}`;
const SHA = "c".repeat(64);

const recording = (patch: Partial<VoiceRecording> = {}): VoiceRecording => ({
  audio: AUDIO as VoiceRecording["audio"],
  durationMs: 4200,
  status: "transcribing",
  transcript: null,
  error: null,
  createdAt: T,
  ...patch,
});

const transcript = {
  text: "今天外面起了点风",
  language: "zh-CN",
  source: "transcribed" as const,
  engine: { engine: "faster-whisper", model: "small" },
};

describe("migration v12 (voice recordings)", () => {
  it("adds voice_recordings on a v11 database without touching old data", () => {
    const file = tempFile("room-v12-");
    const raw = new Database(file);
    raw.pragma("foreign_keys = OFF");
    for (const schema of [
      SCHEMA_V1,
      SCHEMA_V2,
      SCHEMA_V3,
      SCHEMA_V3_REBUILD,
      SCHEMA_V4,
      SCHEMA_V5,
      SCHEMA_V6,
      SCHEMA_V7,
      SCHEMA_V8,
      SCHEMA_V9,
      SCHEMA_V10,
      SCHEMA_V11,
    ]) {
      raw.exec(schema);
    }
    raw.pragma("user_version = 11");
    raw.prepare("INSERT INTO projects (id, name, created_at) VALUES ('proj_old', '旧项目', ?)").run(T);
    raw.close();

    const db = openDatabase(file);
    try {
      assert.equal(currentVersion(db), LATEST_SCHEMA_VERSION);
      assert.ok(LATEST_SCHEMA_VERSION >= 12);
      const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (r) => r.name,
      );
      assert.ok(tables.includes("voice_recordings"));
      assert.equal((db.prepare("SELECT count(*) AS n FROM projects").get() as { n: number }).n, 1);
      assert.deepEqual(db.pragma("foreign_key_check"), []);
    } finally {
      db.close();
    }
    assert.ok(existsSync(file + ".bak-v11"));
  });
});

describe("voice recordings (D-34b 第一段)", () => {
  const fresh = () => openDatabase(tempFile("room-voice-"));

  it("stores a transcribing recording and moves it to ready once", () => {
    const db = fresh();
    try {
      insertVoiceRecording(db, { recording: recording(), sha256: SHA, mime: "audio/wav", bytes: 1024 });
      assert.deepEqual(getVoiceRecording(db, AUDIO), recording());
      assert.equal(findVoiceRecordingBySha(db, SHA)?.audio, AUDIO);
      assert.deepEqual(listVoiceRecordings(db).map((r) => r.audio), [AUDIO]);

      const ready = markVoiceReady(db, AUDIO, transcript);
      assert.equal(ready.status, "ready");
      assert.deepEqual(ready.transcript, transcript);
      assert.equal(ready.error, null);

      // 已经 ready 的不再改
      assert.throws(() => markVoiceReady(db, AUDIO, transcript), VoiceStatusConflictError);
      assert.throws(() => markVoiceFailed(db, AUDIO, "再试一次"), VoiceStatusConflictError);
    } finally {
      db.close();
    }
  });

  it("rejects an empty transcript before writing (a silent recording must not break the list)", () => {
    const db = fresh();
    try {
      insertVoiceRecording(db, { recording: recording(), sha256: SHA, mime: "audio/wav", bytes: 1024 });
      // 静音录音常见：引擎返回空字符串 / 只有空格
      assert.throws(
        () => markVoiceReady(db, AUDIO, { ...transcript, text: "   " }),
        (error: unknown) => error instanceof Error && !(error instanceof VoiceStatusConflictError),
      );
      // 库里还是 transcribing，列表照常能读（C酱 #126）
      assert.equal(getVoiceRecording(db, AUDIO)?.status, "transcribing");
      assert.equal(listVoiceRecordings(db).length, 1);
    } finally {
      db.close();
    }
  });

  it("keeps sha256 unique and blocks updates after the terminal state", () => {
    const db = fresh();
    try {
      insertVoiceRecording(db, { recording: recording(), sha256: SHA, mime: "audio/wav", bytes: 1024 });
      const other = "aud_01JBBBBBBBBBBBBBBBBBBBBBBB";
      assert.throws(
        () =>
          insertVoiceRecording(db, {
            recording: recording({ audio: other as never }),
            sha256: SHA,
            mime: "audio/wav",
            bytes: 1024,
          }),
        /UNIQUE/,
      );

      markVoiceReady(db, AUDIO, transcript);
      assert.throws(
        () => db.prepare("UPDATE voice_recordings SET error = 'x' WHERE audio_ref = ?").run(AUDIO),
        /final/,
      );
    } finally {
      db.close();
    }
  });

  it("marks a recording failed with a reason, and enforces the contract", () => {
    const db = fresh();
    try {
      insertVoiceRecording(db, { recording: recording(), sha256: SHA, mime: "audio/webm", bytes: 2048 });
      const failed = markVoiceFailed(db, AUDIO, "转写引擎不可用");
      assert.equal(failed.status, "failed");
      assert.equal(failed.error, "转写引擎不可用");
      assert.equal(failed.transcript, null);
      assert.throws(() => markVoiceReady(db, AUDIO, transcript), VoiceStatusConflictError);
    } finally {
      db.close();
    }
  });

  it("rejects recordings that do not start as transcribing, bad hashes, and bad audio refs", () => {
    const db = fresh();
    try {
      assert.throws(() =>
        insertVoiceRecording(db, {
          recording: recording({ status: "ready", transcript }),
          sha256: SHA,
          mime: "audio/wav",
          bytes: 1024,
        }),
      );
      assert.throws(() =>
        insertVoiceRecording(db, { recording: recording(), sha256: "ZZ", mime: "audio/wav", bytes: 1024 }),
      );
      assert.throws(() =>
        insertVoiceRecording(db, { recording: recording(), sha256: SHA, mime: "audio/wav", bytes: 0 }),
      );
      // 契约里 ready 必须有转写 / failed 必须有原因
      assert.throws(() => insertVoiceRecording(db, { recording: recording({ status: "ready" }), sha256: SHA, mime: "audio/wav", bytes: 1 }));
      assert.equal(getVoiceRecording(db, "aud_notaulid"), null);
      assert.equal(getVoiceRecording(db, `aud_${"0".repeat(26)}`), null);
    } finally {
      db.close();
    }
  });
});

