import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

// The acceptance build writes startup messages before its final JSON report.
// Treat a missing report (including builds without --self-test) as a failure.
const { values, positionals } = parseArgs({
  options: { "no-sandbox": { type: "boolean" } },
  allowPositionals: true,
});
if (positionals.length !== 2) {
  throw new Error("Usage: node check-packaged-self-test.mjs [--no-sandbox] <exe> <test-profile>");
}
const [exe, profile] = positionals.map((p) => realpathSync(p));
const archive = join(dirname(exe), "resources", "app.asar");
const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
console.log("app.asar SHA-256", digest);

const env = { ...process.env, AGENT_REVIEW_ROOM_DATA: profile };
delete env.ELECTRON_RUN_AS_NODE;
const flags = ["--self-test", "--user-data-dir=" + profile];
if (values["no-sandbox"]) flags.push("--no-sandbox");
const result = spawnSync(exe, flags, { env, encoding: "utf8", timeout: 30000, windowsHide: true });
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Packaged self-test exited with " + (result.status ?? result.signal));
const start = result.stdout.search(/^\{/m);
if (start < 0) throw new Error("Packaged application did not emit a self-test report");
const report = JSON.parse(result.stdout.slice(start));
if (realpathSync(report.userData) !== profile) throw new Error("Application used a different test profile");
if (report.ok !== true) throw new Error("Packaged self-test reported ok=false");
console.log("Packaged self-test passed");
