import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import {
  RunId, RunLedgerIdentity, RunLedgerHeader, RunLedgerRecord, RunLedgerCommit,
  type RemoteRunProof, type RemoteRunFenceCapability,
} from "@room/schemas";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const line = (value: unknown) => JSON.stringify(value) + "\n";
const identityName = "identity.json", recordName = "records.jsonl", commitName = "commits.jsonl";

/** First implementation supports local Windows directories, not aliases or network shares. */
function directory(input: string): string {
  if (process.platform !== "win32" || !/^[a-z]:[\\/]/i.test(input) || input.split(/[\\/]/).some(part => /[. ]$/.test(part))) {
    throw new Error("Run fence requires a local absolute Windows directory without path aliases");
  }
  const resolved = path.resolve(input);
  let current = path.parse(resolved).root;
  for (const part of resolved.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Run fence directories cannot contain links");
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error("Run fence path is not a directory");
  const real = fs.realpathSync.native(resolved);
  if (real.toLowerCase() !== resolved.toLowerCase()) throw new Error("Run fence path alias is not supported");
  return real;
}

async function owner(key: string): Promise<{ assertHeld(): void; close(): Promise<void> }> {
  const server = createServer(socket => socket.destroy());
  const pipe = "\\\\.\\pipe\\agent-room-run-fence-" + hash(key);
  let failed = false;
  server.on("error", () => { failed = true; });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(pipe, resolve);
  });
  server.unref();
  return {
    assertHeld() { if (failed || !server.listening) throw new Error("Run fence owner was lost"); },
    close: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) { resolve(); return; }
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

function ledgerId(): string {
  let bits = (BigInt(Date.now()) << 80n) | BigInt("0x" + randomBytes(10).toString("hex"));
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let id = "";
  for (let i = 0; i < 26; i++) { id = alphabet[Number(bits & 31n)]! + id; bits >>= 5n; }
  return "rled_" + id;
}
function durableWrite(fd: number, bytes: Buffer, position?: number): void {
  let offset = 0;
  while (offset < bytes.length) {
    const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, position === undefined ? null : position + offset);
    if (count <= 0) throw new Error("Run fence write made no progress");
    offset += count;
  }
  fs.fsyncSync(fd);
}
function readEvidence(file: string): string {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Run fence evidence must be a regular unlinked file");
  return fs.readFileSync(file, "utf8");
}
function createFile(file: string, data: string): void {
  const fd = fs.openSync(file, "wx");
  try { durableWrite(fd, Buffer.from(data)); } finally { fs.closeSync(fd); }
}

/** Every mutation is synchronous through both durable commits. Any uncertainty poisons this writer. */
export class RunLedger {
  readonly ledgerId: string;
  private readonly entries = new Map<string, RunLedgerRecord>();
  private readonly identityText: string;
  private recordsText: string;
  private commitsText: string;
  private seq = 0;
  private previousHash: string;
  private failed = false;
  private closed = false;
  private constructor(private readonly dir: string, private readonly release: () => Promise<void>, private readonly assertOwner: () => void, expectedIdentity: string) {
    this.identityText = readEvidence(path.join(dir, identityName));
    if (this.identityText !== expectedIdentity) throw new Error("Run fence identity changed during owner acquisition");
    const identity = RunLedgerIdentity.parse(JSON.parse(this.identityText));
    this.ledgerId = identity.ledgerId;
    const expectedHeader = line(RunLedgerHeader.parse({ version: 1, ledgerId: identity.ledgerId, identityHash: hash(this.identityText) }));
    this.recordsText = readEvidence(path.join(dir, recordName));
    this.commitsText = readEvidence(path.join(dir, commitName));
    if (!this.recordsText.startsWith(expectedHeader) || !this.commitsText.startsWith(expectedHeader) ||
        !this.recordsText.endsWith("\n") || !this.commitsText.endsWith("\n")) throw new Error("Run fence header or tail is damaged");
    const records = this.recordsText.slice(expectedHeader.length).split("\n").slice(0, -1);
    const commits = this.commitsText.slice(expectedHeader.length).split("\n").slice(0, -1);
    if (records.length !== commits.length) throw new Error("Run fence has an uncommitted or missing record");
    this.previousHash = hash(expectedHeader);
    records.forEach((raw, index) => {
      const record = RunLedgerRecord.parse(JSON.parse(raw));
      const commit = RunLedgerCommit.parse(JSON.parse(commits[index]!));
      if (record.ledgerId !== this.ledgerId || commit.ledgerId !== this.ledgerId || record.seq !== this.seq + 1 ||
          commit.seq !== record.seq || record.previousHash !== this.previousHash || commit.recordHash !== hash(raw + "\n")) {
        throw new Error("Run fence chain is damaged");
      }
      this.checkTransition(record);
      this.entries.set(record.runId, record);
      this.seq = record.seq;
      this.previousHash = commit.recordHash;
    });
    // Complete bytes left by a crashed writer are flushed before publishing proof.
    // An unmatched tail still fails above; no truncation or repair is attempted.
    for (const name of [identityName, recordName, commitName]) {
      const fd = fs.openSync(path.join(dir, name), "r+");
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
  }

  /** Explicit initialization only. Existing nonempty directories are never repaired or reused. */
  static async initialize(input: string): Promise<RunLedger> {
    const dir = directory(input);
    const releasePath = await owner("path:" + dir.toLowerCase());
    let releaseIdentity: Awaited<ReturnType<typeof owner>> | undefined;
    try {
      if (fs.readdirSync(dir).length !== 0) throw new Error("Run fence initialization requires an empty directory");
      const identity = RunLedgerIdentity.parse({ version: 1, ledgerId: ledgerId(), nonce: randomBytes(32).toString("hex") });
      releaseIdentity = await owner("ledger:" + identity.ledgerId);
      const text = line(identity);
      const header = line({ version: 1, ledgerId: identity.ledgerId, identityHash: hash(text) });
      createFile(path.join(dir, identityName), text);
      createFile(path.join(dir, recordName), header);
      createFile(path.join(dir, commitName), header);
      const release = releaseIdentity;
      return new RunLedger(dir, async () => { try { await release.close(); } finally { await releasePath.close(); } },
        () => { releasePath.assertHeld(); release.assertHeld(); }, text);
    } catch (error) { try { if (releaseIdentity) await releaseIdentity.close(); } finally { await releasePath.close(); } throw error; }
  }

  static async open(input: string): Promise<RunLedger> {
    const dir = directory(input);
    const releasePath = await owner("path:" + dir.toLowerCase());
    let releaseIdentity: Awaited<ReturnType<typeof owner>> | undefined;
    try {
      const text = readEvidence(path.join(dir, identityName));
      const identity = RunLedgerIdentity.parse(JSON.parse(text));
      releaseIdentity = await owner("ledger:" + identity.ledgerId);
      const release = releaseIdentity;
      return new RunLedger(dir, async () => { try { await release.close(); } finally { await releasePath.close(); } },
        () => { releasePath.assertHeld(); release.assertHeld(); }, text);
    } catch (error) { try { if (releaseIdentity) await releaseIdentity.close(); } finally { await releasePath.close(); } throw error; }
  }

  private healthy(): void {
    if (this.closed || this.failed) throw new Error("Run fence writer is unavailable");
    try {
      this.assertOwner();
      // First version deliberately checks the complete small ledger. Missing,
      // replaced or altered evidence cannot become a fresh in-memory 'missing'.
      directory(this.dir);
      for (const [name, expected] of [[identityName, this.identityText], [recordName, this.recordsText], [commitName, this.commitsText]] as const) {
        const file = path.join(this.dir, name);
        if (readEvidence(file) !== expected) throw new Error("Run fence evidence changed");
      }
    } catch (error) { this.failed = true; throw error; }
  }
  capability(): RemoteRunFenceCapability { this.healthy(); return { version: 1, ledgerId: this.ledgerId }; }
  record(runId: string): RunLedgerRecord | undefined { RunId.parse(runId); this.healthy(); const value = this.entries.get(runId); return value && { ...value }; }
  get unconfirmedCount(): number { this.healthy(); return [...this.entries.values()].filter(entry => entry.transition === "admitted").length; }
  proof(runId: string): RemoteRunProof {
    const record = this.record(runId);
    return { ledgerId: this.ledgerId, runId, status: !record ? "missing" : record.transition === "admitted" ? "unconfirmed" :
      record.transition === "closed_process" ? "closed_process" : "fenced_never_started" };
  }
  admit(runId: string, requestHash: string): void { this.append(runId, requestHash, "admitted"); }
  fence(runId: string): void { if (!this.record(runId)) this.append(runId, null, "fenced"); }
  evidence(runId: string, transition: "never_spawned" | "closed_process"): void {
    const current = this.record(runId);
    if (!current) throw new Error("Run fence evidence has no admission");
    if (current.transition !== "admitted") return;
    this.append(runId, current.requestHash, transition);
  }
  private checkTransition(record: RunLedgerRecord): void {
    const current = this.entries.get(record.runId);
    const first = record.transition === "admitted" || record.transition === "fenced";
    if (first ? current !== undefined : !current || current.transition !== "admitted" || current.requestHash !== record.requestHash) {
      throw new Error("Run fence transition is invalid");
    }
  }
  private append(runId: string, requestHash: string | null, transition: RunLedgerRecord["transition"]): void {
    this.healthy();
    const record = RunLedgerRecord.parse({ ledgerId: this.ledgerId, seq: this.seq + 1, previousHash: this.previousHash, runId, requestHash, transition });
    this.checkTransition(record);
    const text = line(record), recordHash = hash(text);
    const commit = line(RunLedgerCommit.parse({ ledgerId: this.ledgerId, seq: record.seq, recordHash }));
    try {
      for (const [name, data] of [[recordName, text], [commitName, commit]] as const) {
        const fd = fs.openSync(path.join(this.dir, name), "r+");
        try {
          const expected = name === recordName ? this.recordsText : this.commitsText;
          if (fs.readFileSync(fd, "utf8") !== expected) throw new Error("Run fence evidence changed before append");
          durableWrite(fd, Buffer.from(data), Buffer.byteLength(expected));
        } finally { fs.closeSync(fd); }
      }
      this.recordsText += text; this.commitsText += commit;
      this.entries.set(runId, record); this.seq = record.seq; this.previousHash = recordHash;
    } catch (error) { this.failed = true; throw error; }
  }
  /** Seal before releasing ownership: late child callbacks must never write after a new owner enters. */
  async close(): Promise<void> { if (this.closed) return; this.closed = true; await this.release(); }
}
