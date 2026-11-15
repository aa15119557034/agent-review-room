import assert from "node:assert/strict";
import { openDatabase, ulid, WriteQueue } from "@room/db";
import { WorldSnapshot } from "@room/schemas";
import { WorldService } from "../../src/main/world";

async function main(): Promise<void> {
  const dbPath = process.argv[2];
  assert.ok(dbPath);
  assert.ok(process.send, "the crash fixture needs a parent IPC channel");
  const db = openDatabase(dbPath);
  const world = new WorldService({
    db, dbPath, queue: new WriteQueue(), emit: () => {}, knownAgents: () => ["claude"],
    now: () => "2026-11-16T00:00:00.000Z",
  });
  await world.start();
  await world.reset({
    type: "world.reset", requestId: `wact_${ulid()}`, worldId: null, confirm: true,
    settings: { residents: ["claude"], dayRealMinutes: 4, dailyCognitionLimit: 0 },
  });
  const initial = world.get().world!;
  const invitation = await world.act({
    type: "world.act", actionId: `wact_${ulid()}`, worldId: initial.id, generation: initial.generation,
    action: { type: "invite", to: { kind: "resident", agent: "claude" }, activity: "cook" },
  });
  assert.equal(invitation.accepted, true);
  await world.advance(1_000);
  const snapshot = WorldSnapshot.parse(world.get().world);
  const cooking = snapshot.activities.find((activity) => activity.kind === "cook");
  assert.ok(cooking && cooking.startedAt < snapshot.now && snapshot.now < cooking.endsAt);
  // Do not close the connection or install a graceful shutdown handler. The
  // parent must terminate this exact SQLite writer with the WAL still open.
  setInterval(() => {}, 1_000);
  process.send({ type: "cooking", pid: process.pid, snapshot });
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
