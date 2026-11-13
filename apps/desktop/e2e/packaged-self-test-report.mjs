import { realpathSync } from "node:fs";

export function checkPackagedReport(result, profile, print = console.log) {
  if (result.error) throw result.error;
  const start = result.stdout.search(/^\{/m);
  if (start < 0) throw new Error("Packaged application did not emit a self-test report");
  const report = JSON.parse(result.stdout.slice(start));
  // Keep the diagnostic report available even when Electron exits with failure.
  print(JSON.stringify(report, null, 2));
  if (result.status !== 0) throw new Error("Packaged self-test exited with " + (result.status ?? result.signal));
  if (realpathSync(report.userData) !== realpathSync(profile)) throw new Error("Application used a different test profile");
  if (report.ok !== true) throw new Error("Packaged self-test reported ok=false");
  const node = report.nodes?.find((item) => item.id === "controller-local");
  if (node?.tokenSet !== true || node.health?.status !== 200 ||
      !Array.isArray(node.health.body?.profiles) || !node.health.body.profiles.includes("deepseek-chat")) {
    throw new Error("Acceptance requires controller-local with a token, HTTP 200 and deepseek-chat");
  }
  for (const id of ["tts-runtime", "tts-model"]) {
    if (!report.packs?.some((pack) => pack.id === id && pack.state === "installed")) {
      throw new Error("Acceptance requires installed " + id);
    }
  }
}
