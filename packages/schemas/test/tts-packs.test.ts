import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS, ControlEvent, QUERIES, TtsImportRequest, TtsImportResult, TtsPackStatus } from "../src/index";

const status = {
  kind: "runtime", state: "installed", version: "1", expectedVersion: "1", path: "C:/x/tts", missing: [],
  totalBytes: 10, progress: null,
};

test("tts.import never accepts a renderer supplied path", () => {
  assert.equal(TtsImportRequest.safeParse({ type: "tts.import", kind: "model", mode: "zip" }).success, true);
  for (const extra of [{ path: "C:/x.zip" }, { mode: "tar" }, { kind: "other" }])
    assert.equal(TtsImportRequest.safeParse({ type: "tts.import", kind: "model", mode: "zip", ...extra }).success, false);
});

test("pack progress: error appears only with failed", () => {
  const ok = { ...status, progress: { phase: "extracting", doneBytes: 1, totalBytes: null, error: null } };
  assert.equal(TtsPackStatus.safeParse(ok).success, true);
  const bad = { ...status, progress: { phase: "extracting", doneBytes: 1, totalBytes: 2, error: "PACK_BUSY" } };
  assert.equal(TtsPackStatus.safeParse(bad).success, false);
  const noReason = { ...status, progress: { phase: "failed", doneBytes: 0, totalBytes: null, error: null } };
  assert.equal(TtsPackStatus.safeParse(noReason).success, false);
});

test("import result: cancelled cannot carry an error; at most two packs", () => {
  assert.equal(TtsImportResult.safeParse({ cancelled: true, error: null, packs: [status] }).success, true);
  assert.equal(TtsImportResult.safeParse({ cancelled: true, error: "PACK_BUSY", packs: [] }).success, false);
  assert.equal(TtsImportResult.safeParse({ cancelled: false, error: null, packs: [status, status, status] }).success, false);
});

test("tts query, command and event are registered", () => {
  assert.ok("tts.packs" in QUERIES);
  assert.ok("tts.import" in COMMANDS);
  assert.equal(ControlEvent.safeParse({ type: "tts.packs.updated", packs: [status] }).success, true);
});
