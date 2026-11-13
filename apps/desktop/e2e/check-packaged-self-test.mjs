import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { checkPackagedReport } from "./packaged-self-test-report.mjs";

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
checkPackagedReport(result, profile);
console.log("Packaged self-test passed");
