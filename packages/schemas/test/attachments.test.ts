import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_LIMITS,
  AttachmentManifest,
  BatchItem,
  COMMANDS,
  IMAGE_MAX_BYTES,
  ImagePurpose,
  ModelOption,
  NodeHealth,
  StartRunRequest,
  attachmentManifestLine,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const sha = (c: string) => c.repeat(64);
const entry = (index: number, c: string, bytes = 3) => ({ index, name: `图${index}.png`, mime: "image/png", bytes, sha256: sha(c) });

const startRun = {
  protocol: 1,
  runId: `run_${ID}`,
  profileId: "claude-review",
  snapshot: { id: `snap_${ID}`, content: "hi", contentHash: sha("b") },
  limits: { idleTimeoutMs: 60_000, totalTimeoutMs: 600_000 },
};
const att = (index: number, c: string) => ({ index, mime: "image/png", bytes: 3, sha256: sha(c), data: "AAAA" });

describe("attachments (C-42a)", () => {
  it("AttachmentManifest: indices 1..n, no duplicate image, total bytes capped", () => {
    assert.ok(AttachmentManifest.safeParse([]).success);
    assert.ok(AttachmentManifest.safeParse([entry(1, "a"), entry(2, "c")]).success);
    assert.equal(AttachmentManifest.safeParse([entry(2, "a")]).success, false);
    assert.equal(AttachmentManifest.safeParse([entry(1, "a"), entry(3, "c")]).success, false);
    assert.equal(AttachmentManifest.safeParse([entry(1, "a"), entry(2, "a")]).success, false);
    assert.equal(AttachmentManifest.safeParse([entry(1, "a", ATTACHMENT_LIMITS.imageMaxBytes + 1)]).success, false);
    const nine = Array.from({ length: 9 }, (_, i) => entry(i + 1, "0123456789"[i]!));
    assert.equal(AttachmentManifest.safeParse(nine).success, false);
    const big = Array.from({ length: 7 }, (_, i) => entry(i + 1, "0123456"[i]!, ATTACHMENT_LIMITS.imageMaxBytes));
    assert.equal(AttachmentManifest.safeParse(big).success, false, "7 × 2 MB > 12 MB");
    assert.equal(AttachmentManifest.safeParse([{ ...entry(1, "a"), mime: "image/gif" }]).success, false);
    assert.equal(AttachmentManifest.safeParse([{ ...entry(1, "a"), path: "C:/x.png" }]).success, false);
  });

  it("manifest line format is fixed (the node looks for it in content)", () => {
    assert.equal(
      attachmentManifestLine(entry(2, "a", 1234) as never),
      `[附件 2] image/png 1234 bytes sha256=${sha("a")}`,
    );
  });

  it("StartRunRequest: attachments optional; base64 length must match bytes; strict", () => {
    assert.ok(StartRunRequest.safeParse(startRun).success);
    assert.ok(StartRunRequest.safeParse({ ...startRun, attachments: [att(1, "a"), att(2, "c")] }).success);
    assert.equal(StartRunRequest.safeParse({ ...startRun, attachments: [] }).success, false);
    assert.equal(StartRunRequest.safeParse({ ...startRun, attachments: [att(2, "a")] }).success, false);
    assert.equal(StartRunRequest.safeParse({ ...startRun, attachments: [{ ...att(1, "a"), data: "AAAAAAAA" }] }).success, false);
    assert.equal(StartRunRequest.safeParse({ ...startRun, attachments: [{ ...att(1, "a"), data: "AA\nA" }] }).success, false);
    assert.equal(StartRunRequest.safeParse({ ...startRun, attachments: [{ ...att(1, "a"), path: "/etc/passwd" }] }).success, false);
  });

  it("ModelOption.vision is optional and three-state; NodeHealth.capabilities optional", () => {
    const m = { id: "m", displayName: "M", efforts: [], defaultEffort: null };
    assert.ok(ModelOption.safeParse(m).success);
    for (const v of ["yes", "no", "unknown"]) assert.ok(ModelOption.safeParse({ ...m, vision: v }).success, v);
    assert.equal(ModelOption.safeParse({ ...m, vision: true }).success, false);
    const health = { protocol: 1, nodeId: "n", profiles: [], activeRuns: 0, maxConcurrentRuns: 1, leaseMs: 1, heartbeatMs: 1 };
    assert.ok(NodeHealth.safeParse(health).success);
    assert.ok(NodeHealth.safeParse({ ...health, capabilities: { attachments: true } }).success);
    assert.ok(NodeHealth.safeParse({ ...health, capabilities: {} }).success);
  });

  it("BatchItem.attachments is optional (old batches have none)", () => {
    const item = {
      recipient: "claude",
      onBehalfOf: null,
      approvalId: `apr_${ID}`,
      snapshotId: `snap_${ID}`,
      contentHash: sha("b"),
      differsFromOthers: false,
      tokenEstimate: 0,
      model: null,
    };
    assert.ok(BatchItem.safeParse(item).success);
    assert.ok(BatchItem.safeParse({ ...item, attachments: [entry(1, "a")] }).success);
  });

  it("every image purpose has a size limit; generated cannot be picked", () => {
    for (const p of ImagePurpose.options) assert.ok(IMAGE_MAX_BYTES[p] > 0, p);
    const pick = COMMANDS["image.pick"].request;
    assert.ok(pick.safeParse({ type: "image.pick", purpose: "chat" }).success);
    assert.ok(pick.safeParse({ type: "image.pick", purpose: "material" }).success);
    assert.equal(pick.safeParse({ type: "image.pick", purpose: "generated" }).success, false);
  });
});
