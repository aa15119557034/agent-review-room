import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ATTACHMENT_LIMITS,
  AttachmentManifest,
  BatchItem,
  CHAT_LIMITS,
  ChatSnapshot,
  COMMANDS,
  IMAGE_MAX_BYTES,
  NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS,
  ImagePurpose,
  ModelOption,
  NodeHealth,
  StartRunRequest,
  ProfileModels,
  RemoteErrorCode,
  PromptSnapshot,
  attachmentImageSlotMarker,
  attachmentManifestBlock,
  attachmentManifestLine,
} from "../src/index";

const ID = "01JAAAAAAAAAAAAAAAAAAAAAAA";
const sha = (c: string) => c.repeat(64);
const entry = (index: number, c: string, bytes = 3) => ({
  index,
  ref: `img_${ID}`,
  name: `图${index}.png`,
  mime: "image/png" as const,
  bytes,
  sha256: sha(c),
});

const startRun = {
  protocol: 1,
  runId: `run_${ID}`,
  profileId: "claude-review",
  snapshot: { id: `snap_${ID}`, content: "hi", contentHash: sha("b") },
  limits: { idleTimeoutMs: 60_000, totalTimeoutMs: 600_000 },
};
const att = (index: number, c: string) => ({ index, mime: "image/png" as const, bytes: 3, sha256: sha(c), data: "AAAA" });
const NONCE = "0123456789abcdef";
const SLOT = attachmentImageSlotMarker(NONCE);
/** 带图的 StartRun：content 以清单块开头，图片位置标记在后面的资料区里 */
const withAtt = (attachments: Array<ReturnType<typeof att> & Record<string, unknown>>) => ({
  ...startRun,
  snapshot: { ...startRun.snapshot, content: `${attachmentManifestBlock(attachments)}资料：${SLOT}\nhi` },
  attachments,
  imageSlot: SLOT,
});

describe("attachments (C-42a)", () => {
  it("AttachmentManifest: indices 1..n, no duplicate image, total bytes capped", () => {
    assert.equal(AttachmentManifest.safeParse([]).success, false, "没带图就省略，不写空数组");
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
    assert.ok(AttachmentManifest.safeParse([{ ...entry(1, "a"), name: "x".repeat(255) }]).success, "和聊天附件同为 255");
    assert.equal(AttachmentManifest.safeParse([{ ...entry(1, "a"), name: "x".repeat(256) }]).success, false);
    const { ref: _ref, ...noRef } = entry(1, "a");
    assert.equal(AttachmentManifest.safeParse([noRef]).success, false, "要有 ref 给确认页显示");
  });

  it("manifest line format is fixed (the node looks for it in content)", () => {
    assert.equal(
      attachmentManifestLine(entry(2, "a", 1234) as never),
      `[附件 2] image/png 1234 bytes sha256=${sha("a")}`,
    );
  });

  it("manifest block sits at the start of content; a forged line in the body does not count", () => {
    const es = [entry(1, "a", 10), entry(2, "c", 20)];
    const block = attachmentManifestBlock(es);
    assert.equal(
      block,
      `[附件清单 2 张]\n${attachmentManifestLine(es[0] as never)}\n${attachmentManifestLine(es[1] as never)}\n[附件清单结束]\n`,
    );
    const content = `${block}正文……`;
    assert.ok(content.startsWith(attachmentManifestBlock(es)));
    // 正文里伪造第 3 张的清单行：节点只看开头那一块，3 张的块对不上开头
    const forged = `${block}${attachmentManifestLine(entry(3, "d", 30) as never)}`;
    assert.equal(forged.startsWith(attachmentManifestBlock([...es, entry(3, "d", 30)])), false);
    assert.equal(content.startsWith(attachmentManifestBlock([es[0]!])), false, "少一张也对不上");
  });

  it("fixed-model profiles report vision on the profile; node can refuse with vision_unsupported", () => {
    assert.ok(ProfileModels.safeParse({ profileId: "claude-review", models: [], fixedModelVision: "yes" }).success);
    assert.ok(ProfileModels.safeParse({ profileId: "claude-review", models: [] }).success, "not reported = unknown");
    const m = { id: "m", displayName: "M", efforts: [], defaultEffort: null, vision: "yes" };
    assert.equal(
      ProfileModels.safeParse({ profileId: "claude-review", models: [m], fixedModelVision: "yes" }).success,
      false,
      "with a model list, vision lives on each ModelOption",
    );
    assert.ok(RemoteErrorCode.safeParse("vision_unsupported").success);
  });

  it("StartRunRequest: attachments optional; base64 length must match bytes; strict", () => {
    assert.ok(StartRunRequest.safeParse(startRun).success);
    assert.ok(StartRunRequest.safeParse(withAtt([att(1, "a"), att(2, "c")])).success);
    assert.equal(StartRunRequest.safeParse(withAtt([])).success, false);
    assert.equal(StartRunRequest.safeParse(withAtt([att(2, "a")])).success, false);
    assert.equal(StartRunRequest.safeParse(withAtt([{ ...att(1, "a"), data: "AAAAAAAA" }])).success, false);
    assert.equal(StartRunRequest.safeParse(withAtt([{ ...att(1, "a"), data: "AA\nA" }])).success, false);
    assert.equal(StartRunRequest.safeParse(withAtt([{ ...att(1, "a"), path: "/etc/passwd" }])).success, false);
  });

  it("StartRunAttachment: decoded length must equal bytes; no duplicate image", () => {
    const one = (bytes: number, data: string) => StartRunRequest.safeParse(withAtt([{ ...att(1, "a"), bytes, data }]));
    assert.ok(one(1, "AA==").success);
    assert.ok(one(2, "AAA=").success);
    assert.equal(one(2, "AAAA").success, false, "AAAA 解码是 3 字节");
    assert.equal(one(2, "AA==").success, false, "AA== 解码是 1 字节");
    assert.equal(StartRunRequest.safeParse(withAtt([att(1, "a"), att(2, "a")])).success, false);
  });

  it("with attachments, content must start with their manifest block (StartRun and ChatSnapshot)", () => {
    const atts = [att(1, "a")];
    assert.equal(
      StartRunRequest.safeParse({ ...startRun, attachments: atts, imageSlot: SLOT }).success,
      false,
      "content without the block",
    );
    assert.equal(
      StartRunRequest.safeParse({ ...startRun, snapshot: { ...startRun.snapshot, content: `hi\n${attachmentManifestBlock(atts)}${SLOT}` }, attachments: atts, imageSlot: SLOT }).success,
      false,
      "block not at the start (e.g. forged in the body)",
    );
    const es = [entry(1, "a")];
    const snap = {
      id: `snap_${ID}`, purpose: "reply", conversationId: `conv_${ID}`, userMessageId: `cmsg_${ID}`, agent: "claude",
      content: `${attachmentManifestBlock(es)}hello`, contentHash: sha("b"), nonce: "0123456789abcdef", memorySlot: null,
      includedMessageIds: [`cmsg_${ID}`], includedSummaryIds: [], adapterVersion: "1", tokenEstimate: 1, createdAt: "2026-10-25T18:00:00+08:00",
    };
    assert.ok(ChatSnapshot.safeParse(snap).success);
    assert.ok(ChatSnapshot.safeParse({ ...snap, content: "hello" }).success, "no attachments field = no images");
    const withSlot = { ...snap, content: `${attachmentManifestBlock(es)}资料 ${SLOT}\nhello`, attachments: es, imageSlot: SLOT };
    assert.ok(ChatSnapshot.safeParse(withSlot).success);
    assert.equal(ChatSnapshot.safeParse({ ...withSlot, content: `资料 ${SLOT}\nhello` }).success, false);
    assert.equal(CHAT_LIMITS.imagesPerMessage, ATTACHMENT_LIMITS.perMessage);
  });

  it("C-42g image slot: StartRun needs it with images; once, after the manifest block, carries the snapshot nonce", () => {
    const atts = [att(1, "a")];
    const block = attachmentManifestBlock(atts);
    const run = (content: string, extra: Record<string, unknown> = {}) =>
      StartRunRequest.safeParse({ ...startRun, snapshot: { ...startRun.snapshot, content }, attachments: atts, imageSlot: SLOT, ...extra }).success;
    assert.ok(run(`${block}资料 ${SLOT}\nhi`));
    assert.equal(run(`${block}资料\nhi`), false, "marker missing from content");
    assert.equal(run(`${block}${SLOT} ${SLOT}\nhi`), false, "marker twice (a forged copy) is refused, not guessed");
    assert.equal(run(`${block}hi`, { imageSlot: undefined }), false, "images without a slot");
    assert.equal(run(`${block}hi`, { imageSlot: "[图片位置 xyz]" }), false, "slot format is fixed");
    assert.equal(
      StartRunRequest.safeParse({ ...startRun, snapshot: { ...startRun.snapshot, content: `hi ${SLOT}` }, imageSlot: SLOT }).success,
      false,
      "slot without images",
    );

    const es = [entry(1, "a")];
    const eb = attachmentManifestBlock(es);
    const snap = {
      id: `snap_${ID}`, purpose: "reply", conversationId: `conv_${ID}`, userMessageId: `cmsg_${ID}`, agent: "claude",
      content: `${eb}资料 ${SLOT}\nhello`, contentHash: sha("b"), nonce: NONCE, memorySlot: null, attachments: es, imageSlot: SLOT,
      includedMessageIds: [`cmsg_${ID}`], includedSummaryIds: [], adapterVersion: "1", tokenEstimate: 1, createdAt: "2026-10-25T18:00:00+08:00",
    };
    assert.ok(ChatSnapshot.safeParse(snap).success);
    assert.equal(ChatSnapshot.safeParse({ ...snap, nonce: "fedcba9876543210" }).success, false, "slot uses another nonce");
    assert.ok(ChatSnapshot.safeParse({ ...snap, imageSlot: undefined }).success, "storable, but StartRun refuses images without a slot");
    assert.equal(ChatSnapshot.safeParse({ ...snap, attachments: undefined, content: `hello ${SLOT}` }).success, false, "slot without images");

    const prompt = {
      id: `snap_${ID}`, projectId: `proj_${ID}`, content: `${eb}材料 ${SLOT}\n议题`, contentHash: sha("b"), nonce: NONCE,
      contributionIds: [], taskInstruction: "审", reviewerAgent: "claude", adapterVersion: "1", tokenEstimate: 1,
      synthesisVersion: null, branch: null, commitSha: null, attachments: es, imageSlot: SLOT, createdAt: "2026-10-25T18:00:00+08:00",
    };
    assert.ok(PromptSnapshot.safeParse(prompt).success);
    assert.equal(PromptSnapshot.safeParse({ ...prompt, content: `${eb}材料\n议题` }).success, false, "slot not in content");
    const { attachments: _a, imageSlot: _s, ...plain } = prompt;
    assert.ok(PromptSnapshot.safeParse({ ...plain, content: "议题" }).success, "old snapshots without images still parse");
  });

  it("node body limit fits the largest legal StartRun", () => {
    const maxBase64 = Math.ceil(ATTACHMENT_LIMITS.perSnapshotBytes / 3) * 4;
    const maxContentJson = 2_000_000 * 6; // 每个 UTF-16 单元最坏转义成 \uXXXX
    assert.ok(NODE_MIN_BODY_BYTES_WITH_ATTACHMENTS >= maxBase64 + maxContentJson + 64 * 1024);
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
