import { RunLedger } from "../../src/run-ledger";
const [, , dir, tag, admit] = process.argv;
try {
  const ledger = await RunLedger.open(dir!);
  if (admit) ledger.admit(admit, "a".repeat(64));
  process.send!({ ok: true, pid: process.pid, tag, ledgerId: ledger.ledgerId });
  process.on("message", async message => { if (message === "close") { await ledger.close(); process.disconnect(); } });
} catch (error) {
  process.send!({ ok: false, pid: process.pid, tag, message: (error as Error).message }, () => process.disconnect());
}
