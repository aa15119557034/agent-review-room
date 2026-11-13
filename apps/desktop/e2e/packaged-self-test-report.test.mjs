import assert from "node:assert/strict";
import { test } from "node:test";
import { checkPackagedReport } from "./packaged-self-test-report.mjs";

function configured() {
  return {
    ok: true, userData: process.cwd(),
    nodes: [{ id: "controller-local", tokenSet: true, health: { status: 200, body: { profiles: ["deepseek-chat"] } } }],
    packs: [{ id: "tts-runtime", state: "installed" }, { id: "tts-model", state: "installed" }],
  };
}

function run(report, status = 0, print = () => {}) {
  checkPackagedReport({ status, stdout: "[startup] ready\n" + JSON.stringify(report) }, process.cwd(), print);
}

test("configured report passes with startup logging", () => run(configured()));
test("ok=true with an empty configuration fails acceptance", () => {
  assert.throws(() => run({ ok: true, userData: process.cwd(), nodes: [], packs: [] }), /controller-local/);
});
for (const [name, change] of [
  ["missing token", (r) => { r.nodes[0].tokenSet = false; }],
  ["HTTP 401", (r) => { r.nodes[0].health.status = 401; }],
  ["unreachable node", (r) => { r.nodes[0].health = { error: "fetch failed" }; }],
  ["missing chat profile", (r) => { r.nodes[0].health.body.profiles = ["codex-chat"]; }],
  ["missing runtime", (r) => { r.packs.shift(); }],
  ["incomplete model", (r) => { r.packs[1].state = "incomplete"; }],
]) {
  test(name + " fails acceptance even with ok=true", () => {
    const report = configured();
    change(report);
    assert.throws(() => run(report), /Acceptance requires/);
  });
}
for (const status of [0, 1]) {
  test("ok=false report is printed before rejecting exit " + status, () => {
    const report = configured();
    report.ok = false;
    const output = [];
    assert.throws(() => run(report, status, (text) => output.push(text)), status ? /exited with 1/ : /ok=false/);
    assert.deepEqual(JSON.parse(output[0]), report);
  });
}
test("nonzero exit remains a failure with a healthy report", () => {
  assert.throws(() => run(configured(), 2), /exited with 2/);
});
test("missing and malformed reports fail", () => {
  for (const stdout of ["no report", "{broken"]) {
    assert.throws(() => checkPackagedReport({ status: 0, stdout }, process.cwd(), () => {}));
  }
});
