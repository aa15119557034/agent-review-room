import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { openDatabase, ulid, WorldStore, WriteQueue } from "@room/db";
import { ControlEvent, WorldSnapshot } from "@room/schemas";
import { WorkspaceService, verifyRestoredDirectory, verifyWorkspaceBackup } from "../src/main/workspace";
import { WorldService } from "../src/main/world";

function stock(world: WorldSnapshot, id: string): number {
  const item = world.items.find((entry) => entry.id === id);
  assert.ok(item?.kind === "stock");
  return item.count;
}

test("world backup and restored-copy activation preserve an in-progress cook and the user's run intent", { timeout: 15_000 }, async (t) => {
  for (const userPaused of [false, true]) {
    await t.test(userPaused ? "already paused by user" : "running before backup", async () => {
      const root = resolve(mkdtempSync(join(tmpdir(), "room-world-backup-")));
      const data = join(root, "data"), output = join(root, "copies");
      mkdirSync(data); mkdirSync(output);
      const sourcePath = join(data, "room.db"), sourceDb = openDatabase(sourcePath), queue = new WriteQueue();
      const emit = (event: ControlEvent) => { ControlEvent.parse(event); };
      const source = new WorldService({
        db: sourceDb, dbPath: sourcePath, queue, emit, knownAgents: () => ["claude"],
        now: () => "2026-11-16T00:00:00.000Z",
      });
      let restoredDb: ReturnType<typeof openDatabase> | undefined;
      let restoredWorld: WorldService | undefined;
      try {
        await source.start();
        await source.reset({
          type: "world.reset", requestId: `wact_${ulid()}`, worldId: null, confirm: true,
          settings: { residents: ["claude"], dayRealMinutes: 4, dailyCognitionLimit: 0 },
        });
        const initial = source.get().world!;
        assert.equal((await source.act({
          type: "world.act", actionId: `wact_${ulid()}`, worldId: initial.id, generation: initial.generation,
          action: { type: "invite", to: { kind: "resident", agent: "claude" }, activity: "cook" },
        })).accepted, true);
        await source.advance(1_000);
        if (userPaused) await source.pause(initial.id);
        const before = WorldSnapshot.parse(source.get().world);
        const cooking = before.activities.find((activity) => activity.kind === "cook");
        assert.ok(cooking && cooking.startedAt < before.now && before.now < cooking.endsAt);
        assert.equal(stock(before, "ingredients"), stock(initial, "ingredients") - 1);

        const selections: string[] = [output];
        let maintenanceCalls = 0;
        let selectedDirectory: string | null | undefined;
        const workspace = new WorkspaceService({
          db: sourceDb, queue, userData: data, version: "world-e2e", revision: "world-backup-test",
          checks: async () => [], chooseSaveFile: async () => null,
          chooseDirectory: async () => {
            const selection = selections.shift();
            assert.ok(selection, "every chooser result is an explicit test directory");
            return selection;
          },
          confirmSwitch: async () => true,
          activateDirectory: (target) => { selectedDirectory = target; },
          withWorldMaintenance: (work) => source.maintenance(async () => {
            maintenanceCalls++;
            assert.deepEqual(source.get().world!.run, { state: "paused", by: userPaused ? "user" : "maintenance" });
            await source.advance(5_000);
            assert.equal(source.get().world!.now, before.now, "the backup barrier blocks world advancement");
            return work();
          }),
          withWorldSwitch: (work) => source.beginSwitch(work),
        });

        const backup = await workspace.backup();
        assert.ok(backup.path);
        assert.equal(maintenanceCalls, 1);
        assert.deepEqual(source.get().world!.run, userPaused ? { state: "paused", by: "user" } : { state: "running" });
        assert.equal(source.get().world!.now, before.now);
        const manifest = verifyWorkspaceBackup(backup.path);
        const backupDb = openDatabase(join(backup.path, "room.db"), { readonly: true });
        try {
          const saved = new WorldStore(backupDb).load()!.world;
          assert.deepEqual(saved.run, { state: "paused", by: userPaused ? "user" : "maintenance" });
          assert.equal(saved.now, before.now);
          assert.deepEqual(saved.activities, before.activities);
          assert.deepEqual(saved.commitments, before.commitments);
          assert.deepEqual(saved.items, before.items);
          assert.equal(saved.lastSeq, before.lastSeq);
        } finally { backupDb.close(); }

        selections.push(backup.path, output);
        const copy = await workspace.restore();
        assert.ok(copy.path);
        assert.notEqual(copy.path, data);
        assert.equal(verifyRestoredDirectory(copy.path), manifest.databaseVersion);
        selections.push(copy.path);
        assert.equal((await workspace.openRestored()).path, copy.path);
        assert.equal(selectedDirectory, copy.path);
        assert.equal(selections.length, 0);
        const inactiveSource = WorldSnapshot.parse(source.get().world);
        await source.advance(5_000);
        assert.deepEqual(source.get().world, inactiveSource, "activation permanently stops the old world writer");

        const copyPath = join(copy.path, "room.db");
        const reopenCopy = async () => {
          restoredDb = openDatabase(copyPath);
          restoredWorld = new WorldService({
            db: restoredDb, dbPath: copyPath, queue: new WriteQueue(), emit, knownAgents: () => ["claude"],
            now: () => "2036-11-16T00:00:00.000Z",
          });
          await restoredWorld.start();
          return restoredWorld;
        };
        let restored = await reopenCopy();
        const recovered = WorldSnapshot.parse(restored.get().world);
        assert.equal(recovered.id, before.id);
        assert.notEqual(recovered.generation.session, before.generation.session);
        assert.notEqual(recovered.asOf, before.asOf);
        assert.equal(recovered.now, before.now, "restoring ten wall-clock years later does not catch up world time");
        assert.equal(recovered.lastSeq, before.lastSeq);
        assert.deepEqual(recovered.activities, before.activities);
        assert.deepEqual(recovered.commitments, before.commitments);
        assert.deepEqual(recovered.items, before.items);
        assert.deepEqual(recovered.run, userPaused ? { state: "paused", by: "user" } : { state: "running" });
        if (userPaused) {
          await restored.advance(5_000);
          assert.equal(restored.get().world!.now, before.now, "a pre-existing user pause survives the entire restore chain");
          await restored.resume(before.id);
        }

        const remainingMs = (cooking.endsAt - recovered.now) / restored.get().world!.minutesPerRealSecond * 1_000;
        assert.ok(remainingMs > 0 && remainingMs <= 5_000);
        await restored.advance(remainingMs);
        const completed = WorldSnapshot.parse(restored.get().world);
        assert.equal(completed.now, cooking.endsAt);
        assert.equal(completed.activities.some((activity) => activity.id === cooking.id), false);
        assert.equal(stock(completed, "ingredients"), stock(before, "ingredients"));
        assert.equal(stock(completed, "meals"), stock(before, "meals") + 4);
        const endings = () => restored.events(before.id, undefined, 100).items
          .filter((event) => event.type === "activity_ended" && event.activity.id === cooking.id);
        assert.equal(endings().length, 1);
        const ending = endings()[0]!;
        assert.ok(ending.type === "activity_ended");
        assert.deepEqual(ending.produced, [{ itemId: "meals", count: 4 }]);
        assert.deepEqual(ending.consumed, [{ itemId: "ingredients", count: 1 }]);

        await restored.stop();
        restoredDb!.close();
        restored = await reopenCopy();
        await restored.advance(1_000);
        assert.equal(endings().length, 1, "reopening the restored copy cannot settle the cook twice");
        assert.equal(stock(restored.get().world!, "meals"), stock(before, "meals") + 4);
        assert.deepEqual(source.get().world, inactiveSource, "the restored writer never mutates the original database");
        assert.deepEqual(verifyWorkspaceBackup(backup.path), manifest, "the published backup remains immutable");
        assert.equal(restoredDb!.pragma("integrity_check", { simple: true }), "ok");
      } finally {
        await restoredWorld?.stop();
        if (restoredDb?.open) restoredDb.close();
        await source.stop();
        sourceDb.close();
        assert.equal(dirname(root), resolve(tmpdir()));
        assert.ok(basename(root).startsWith("room-world-backup-"));
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
  }
});
