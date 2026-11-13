import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nodeEntry, selfTestOk } from "../src/main/cli";

const missing = [{ id: "tts-runtime", state: "missing" }, { id: "tts-model", state: "missing" }];
const installed = [{ id: "tts-runtime", state: "installed" }, { id: "tts-model", state: "installed" }];
const healthy = { id: "controller-local", tokenSet: true, undecryptable: false, health: { status: 200, body: { profiles: ["deepseek-chat"] } } };
const noToken = { id: "controller-local", tokenSet: false, undecryptable: false, health: null };

describe("--self-test 的结论（#218 第三轮建议 1/3）", () => {
  it("空配置：包 missing、节点没 Token → true", () => {
    assert.equal(selfTestOk(missing, [noToken], false), true);
  });
  it("节点不在 settings 里：tokenSet 是 false，空配置不算坏", () => {
    const entry = nodeEntry("controller-local", null, null);
    assert.deepEqual(entry, { id: "controller-local", baseUrl: null, tokenSet: false, undecryptable: false, health: null });
    assert.equal(selfTestOk(missing, [entry], false), true);
  });
  it("有密文但解不开：tokenSet true、undecryptable true → false", () => {
    const entry = nodeEntry("controller-local", "http://127.0.0.1:7420", { token: null, undecryptable: true });
    assert.equal(entry.tokenSet, true);
    assert.equal(selfTestOk(missing, [entry], false), false);
  });
  it("配了 Token 但节点连不上 → false", () => {
    assert.equal(selfTestOk(missing, [{ ...healthy, health: { error: "fetch failed" } as never }], false), false);
  });
  it("codex 配了 Token 但 401 → false", () => {
    const codex = { id: "controller-local-codex", tokenSet: true, undecryptable: false, health: { status: 401 } };
    assert.equal(selfTestOk(missing, [noToken, codex], false), false);
  });
  it("有密文但解不开 → false", () => {
    assert.equal(selfTestOk(missing, [{ ...noToken, undecryptable: true }], false), false);
  });
  it("两个包 installed 但 TTS bundle 找不到 → false", () => {
    assert.equal(selfTestOk(installed, [noToken], false), false);
  });
  it("包 incomplete → false", () => {
    assert.equal(selfTestOk([{ id: "tts-runtime", state: "incomplete" }], [noToken], true), false);
  });
  it("一切都配好 → true", () => {
    assert.equal(selfTestOk(installed, [healthy], true), true);
  });
});
