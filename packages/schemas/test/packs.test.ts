import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, ControlEvent, PackImportRequest, PackImportResult, PackStatus, Packs, QUERIES } from "../src/index";

const status = {
  id: "tts-runtime", label: "语音运行环境", description: "语音合成用的 Python 和依赖", state: "installed", version: "1",
  expectedVersion: "1", path: "C:/x/tts", missing: [], totalBytes: 10, progress: null,
};
const patch = { ...status, id: "patch-2026-11", label: "补丁", state: "missing", version: null, expectedVersion: null, path: null, totalBytes: null };

test("packs.import never accepts a renderer supplied path; id may be null (auto-detect)", () => {
  assert.equal(PackImportRequest.safeParse({ type: "packs.import", id: "tts-model", mode: "zip" }).success, true);
  assert.equal(PackImportRequest.safeParse({ type: "packs.import", id: null, mode: "folder" }).success, true);
  for (const extra of [{ path: "C:/x.zip" }, { mode: "tar" }, { id: "Bad Id" }, { id: undefined }])
    assert.equal(PackImportRequest.safeParse({ type: "packs.import", id: "tts-model", mode: "zip", ...extra }).success, false);
});

test("pack list is open-ended but ids are unique; patch packs need no expected version", () => {
  assert.equal(Packs.safeParse([status, patch]).success, true);
  assert.equal(Packs.safeParse([]).success, true);
  assert.equal(Packs.safeParse([status, status]).success, false);
});

test("pack progress: error appears only with failed", () => {
  const ok = { ...status, progress: { phase: "extracting", doneBytes: 1, totalBytes: null, error: null } };
  assert.equal(PackStatus.safeParse(ok).success, true);
  const bad = { ...status, progress: { phase: "extracting", doneBytes: 1, totalBytes: 2, error: "PACK_BUSY" } };
  assert.equal(PackStatus.safeParse(bad).success, false);
  const noReason = { ...status, progress: { phase: "failed", doneBytes: 0, totalBytes: null, error: null } };
  assert.equal(PackStatus.safeParse(noReason).success, false);
});

test("import result: cancelled cannot carry an error; unknown package is an error code", () => {
  assert.equal(PackImportResult.safeParse({ cancelled: true, packId: null, error: null, packs: [status] }).success, true);
  assert.equal(PackImportResult.safeParse({ cancelled: false, packId: null, error: "PACK_UNKNOWN", packs: [status] }).success, true);
  assert.equal(PackImportResult.safeParse({ cancelled: false, packId: "tts-model", error: "PACK_NO_SPACE", packs: [status] }).success, true);
  assert.equal(PackImportResult.safeParse({ cancelled: true, packId: null, error: "PACK_BUSY", packs: [] }).success, false);
});

test("packs query, command and event are registered", () => {
  assert.ok("packs.list" in QUERIES);
  assert.ok("packs.import" in COMMANDS);
  assert.equal(ControlEvent.safeParse({ type: "packs.updated", packs: [status, patch] }).success, true);
});
