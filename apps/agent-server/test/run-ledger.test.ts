import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { RunLedger } from "../src/run-ledger";

const windows = { skip: process.platform !== "win32" };
const id = (n: number) => "run_" + n.toString().padStart(26, "0");
const hash = "a".repeat(64);
const temp = () => fs.mkdtempSync(join(tmpdir(), "room-run-fence-"));

test("ledger commits identities and transitions, rejects damaged/missing evidence, and never repairs", windows, async () => {
  const dir = temp();
  try {
    await assert.rejects(RunLedger.open(dir));
    let ledger = await RunLedger.initialize(dir);
    const identity = ledger.ledgerId;
    assert.equal(ledger.proof(id(1)).status, "missing");
    ledger.fence(id(1)); ledger.fence(id(1));
    assert.equal(ledger.proof(id(1)).status, "fenced_never_started");
    assert.throws(() => ledger.admit(id(1), hash), /transition/);
    ledger.admit(id(2), hash);
    assert.equal(ledger.unconfirmedCount, 1);
    ledger.evidence(id(2), "closed_process");
    ledger.admit(id(3), hash); ledger.evidence(id(3), "never_spawned");
    await ledger.close();
    ledger = await RunLedger.open(dir);
    assert.equal(ledger.ledgerId, identity);
    assert.equal(ledger.proof(id(2)).status, "closed_process");
    assert.equal(ledger.proof(id(3)).status, "fenced_never_started");
    assert.equal(ledger.unconfirmedCount, 0);
    fs.appendFileSync(join(dir, "records.jsonl"), "partial");
    assert.throws(() => ledger.proof(id(99)), /changed/);
    await ledger.close();
    await assert.rejects(RunLedger.open(dir));
    await assert.rejects(RunLedger.initialize(dir), /empty directory/);
    fs.unlinkSync(join(dir, "identity.json"));
    await assert.rejects(RunLedger.open(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

for (const operation of ["write", "fsync"] as const) for (const at of [1, 2]) {
  test(operation + " failure at append stage " + at + " cannot publish proof or keep the writer usable", windows, async t => {
    const dir = temp(); const ledger = await RunLedger.initialize(dir);
    let count = 0;
    const originalWrite = fs.writeSync, originalSync = fs.fsyncSync;
    if (operation === "write") t.mock.method(fs, "writeSync", ((...args: Parameters<typeof fs.writeSync>) => {
      if (++count === at) throw new Error("injected write");
      return (originalWrite as (...a: Parameters<typeof fs.writeSync>) => number)(...args);
    }) as typeof fs.writeSync);
    else t.mock.method(fs, "fsyncSync", (fd: number) => { if (++count === at) throw new Error("injected fsync"); originalSync(fd); });
    try {
      assert.throws(() => ledger.fence(id(1)), /injected/);
      assert.throws(() => ledger.proof(id(1)), /unavailable/);
      assert.throws(() => ledger.admit(id(2), hash), /unavailable/);
      t.mock.restoreAll(); await ledger.close();
      if (operation === "write" && at === 1) {
        const next = await RunLedger.open(dir); assert.equal(next.proof(id(1)).status, "missing"); await next.close();
      } else if (operation === "fsync" && at === 2) {
        // Both complete records are revalidated and flushed by the new owner.
        const next = await RunLedger.open(dir); assert.equal(next.proof(id(1)).status, "fenced_never_started"); await next.close();
      } else await assert.rejects(RunLedger.open(dir), /uncommitted|missing/);
    } finally { t.mock.restoreAll(); await ledger.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("real owners reject same path and copied ledger identity; crash after admission remains unconfirmed", windows, async () => {
  const dir = temp(), copy = temp();
  const first = await RunLedger.initialize(dir); await first.close();
  const children: { proc: ReturnType<typeof spawn>; done: Promise<void> }[] = [];
  async function child(where: string, admit?: string) {
    const tag = Math.random().toString();
    const proc = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./fixtures/run-ledger-worker.ts", import.meta.url)), where, tag, ...(admit ? [admit] : [])], {
      cwd: resolve("."), windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const done = new Promise<void>(resolve => proc.once("close", () => resolve()));
    children.push({ proc, done });
    const message = await new Promise<{ ok: boolean; pid: number; tag: string; ledgerId: string }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("owner child did not respond")), 5000);
      proc.once("message", message => { clearTimeout(timeout); resolve(message as never); });
      proc.once("error", error => { clearTimeout(timeout); reject(error); });
    });
    assert.equal(message.pid, proc.pid); assert.equal(message.tag, tag);
    return { proc, message, done };
  }
  try {
    const owner = await child(dir, id(7)); assert.equal(owner.message.ok, true);
    const second = await child(dir.toUpperCase()); assert.equal(second.message.ok, false); await second.done;
    fs.cpSync(dir, copy, { recursive: true });
    const clone = await child(copy); assert.equal(clone.message.ok, false); await clone.done;
    assert.equal(owner.proc.pid, owner.message.pid); assert.equal(owner.proc.kill("SIGKILL"), true); await owner.done;
    const recovered = await RunLedger.open(dir);
    assert.equal(recovered.ledgerId, owner.message.ledgerId);
    assert.equal(recovered.proof(id(7)).status, "unconfirmed");
    assert.equal(recovered.unconfirmedCount, 1);
    assert.throws(() => recovered.admit(id(7), hash), /transition/);
    await recovered.close();
    const again = await child(dir); assert.equal(again.message.ok, true);
    again.proc.send("close"); await again.done;
  } finally {
    for (const { proc } of children) if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    await Promise.all(children.map(child => child.done));
    fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(copy, { recursive: true, force: true });
  }
});


for (const file of ["identity.json", "records.jsonl", "commits.jsonl"]) {
  test("missing " + file + " refuses the original identity instead of returning missing", windows, async () => {
    const dir = temp(); const ledger = await RunLedger.initialize(dir);
    ledger.fence(id(1)); await ledger.close();
    try { fs.unlinkSync(join(dir, file)); await assert.rejects(RunLedger.open(dir)); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test("partial successful writes are completed and unsupported directory aliases are rejected", windows, async t => {
  const dir = temp(), alias = dir + "-alias";
  const ledger = await RunLedger.initialize(dir);
  const write = fs.writeSync;
  t.mock.method(fs, "writeSync", ((fd: number, buffer: Buffer, offset: number, length: number, position: number | null) =>
    write(fd, buffer, offset, Math.min(3, length), position)) as typeof fs.writeSync);
  try {
    ledger.fence(id(1)); assert.equal(ledger.proof(id(1)).status, "fenced_never_started");
    t.mock.restoreAll(); await ledger.close();
    const next = await RunLedger.open(dir); assert.equal(next.proof(id(1)).status, "fenced_never_started"); await next.close();
    fs.symlinkSync(dir, alias, "junction");
    await assert.rejects(RunLedger.open(alias), /links/);
    await assert.rejects(RunLedger.open("\\\\server\\share\\ledger"), /local absolute/);
    await assert.rejects(RunLedger.open("relative-ledger"), /local absolute/);
  } finally { t.mock.restoreAll(); await ledger.close(); if (fs.existsSync(alias)) fs.unlinkSync(alias); fs.rmSync(dir, { recursive: true, force: true }); }
});


test("identity cannot change between owner acquisition and replay while another ledger owns that identity", windows, async t => {
  const a = temp(), b = temp();
  const initial = await RunLedger.initialize(a); await initial.close();
  const ownerB = await RunLedger.initialize(b);
  const names = ["identity.json", "records.jsonl", "commits.jsonl"];
  const originalA = names.map(name => fs.readFileSync(join(a, name)));
  let identityReads = 0, wronglyOpened: RunLedger | undefined;
  const read = fs.readFileSync;
  t.mock.method(fs, "readFileSync", ((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === join(a, "identity.json") && ++identityReads === 2) {
      for (const name of names) fs.copyFileSync(join(b, name), join(a, name));
    }
    return read(...args);
  }) as typeof fs.readFileSync);
  try {
    await assert.rejects(async () => { wronglyOpened = await RunLedger.open(a); }, /identity changed/);
    t.mock.restoreAll();
    assert.equal(ownerB.capability().ledgerId, ownerB.ledgerId);
    await assert.rejects(RunLedger.open(b), /EADDRINUSE/);
    for (let i = 0; i < names.length; i++) fs.writeFileSync(join(a, names[i]!), originalA[i]!);
    const again = await RunLedger.open(a); await again.close();
  } finally {
    t.mock.restoreAll(); await wronglyOpened?.close(); await ownerB.close();
    fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true });
  }
});
