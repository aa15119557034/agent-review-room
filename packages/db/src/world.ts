import { realpathSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import {
  AgentName, WorldActionId, WorldDayReview, WorldEvent, WorldEventsPage, WorldEventsRequest,
  WorldGeneration, WorldId, WorldObservation, WorldResidentView, WorldScene, WorldSceneId,
  WorldScenesPage, WorldScenesRequest, WorldSettings, WorldSnapshot,
} from "@room/schemas";
import type { SqliteDatabase } from "./database";
import { ulid } from "./ulid";

/** Synchronous persistence only. The caller owns the surrounding writeTransaction. */
export class WorldStore {
  readonly #generation: WorldGeneration;

  constructor(private readonly db: SqliteDatabase, generation?: WorldGeneration) {
    this.#generation = WorldGeneration.parse(generation ?? { session: "wses_" + ulid(), runSeq: 0 });
  }

  #writing(): void {
    if (!this.db.inTransaction) throw new Error("WorldStore writes require a transaction");
  }

  load(generation: WorldGeneration = this.#generation): { world: WorldSnapshot; initial: WorldSnapshot; settings: WorldSettings } | null {
    const row = this.db.prepare(
      "SELECT w.current_json, w.initial_json FROM world_active a JOIN worlds w ON w.id = a.world_id WHERE a.singleton = 1",
    ).get() as { current_json: string; initial_json: string } | undefined;
    if (row === undefined) return null;
    const settings = this.settings();
    if (settings === null) throw new Error("active world has no settings");
    const currentGeneration = WorldGeneration.parse(generation);
    return {
      world: WorldSnapshot.parse({ ...JSON.parse(row.current_json), generation: currentGeneration }),
      initial: WorldSnapshot.parse({ ...JSON.parse(row.initial_json), generation: currentGeneration }),
      settings,
    };
  }

  settings(): WorldSettings | null {
    const row = this.db.prepare("SELECT settings_json FROM world_settings WHERE singleton = 1").get() as { settings_json: string } | undefined;
    return row === undefined ? null : WorldSettings.parse(JSON.parse(row.settings_json));
  }

  saveSettings(settings: WorldSettings): void {
    this.#writing();
    const parsed = WorldSettings.parse(settings);
    this.db.prepare("INSERT INTO world_settings(singleton, settings_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET settings_json = excluded.settings_json")
      .run(JSON.stringify(parsed));
  }

  create(world: WorldSnapshot, settings: WorldSettings): void {
    this.#writing();
    const parsed = WorldSnapshot.parse(world);
    if (parsed.lastSeq !== 0) throw new Error("a new world must start before its first event");
    const json = snapshotJson(parsed);
    this.db.prepare("INSERT INTO worlds(id, rules_version, initial_json, current_json) VALUES (?, ?, ?, ?)")
      .run(parsed.id, parsed.rulesVersion, json, json);
    this.saveSettings(settings);
    this.db.prepare("INSERT INTO world_active(singleton, world_id) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET world_id = excluded.world_id")
      .run(parsed.id);
  }

  save(world: WorldSnapshot): void {
    this.#writing();
    const parsed = WorldSnapshot.parse(world);
    const changed = this.db.prepare(
      "UPDATE worlds SET current_json = ? WHERE id = ? AND rules_version = ? AND id = (SELECT world_id FROM world_active WHERE singleton = 1)",
    ).run(snapshotJson(parsed), parsed.id, parsed.rulesVersion).changes;
    if (changed !== 1) throw new Error("world is not active or its rules version changed");
  }

  append(worldId: string, events: readonly WorldEvent[], observations: readonly WorldObservation[], views: readonly WorldResidentView[]): void {
    this.#writing();
    WorldId.parse(worldId);
    const parsedEvents = events.map((event) => WorldEvent.parse(event));
    const parsedObservations = observations.map((observation) => WorldObservation.parse(observation));
    const parsedViews = views.map((view) => WorldResidentView.parse(view));
    for (const view of parsedViews) if (view.worldId !== worldId) throw new Error("resident view belongs to another world");
    const insertEvent = this.db.prepare("INSERT INTO world_events(world_id, seq, kind, event_json) VALUES (?, ?, ?, ?)");
    for (const event of parsedEvents) insertEvent.run(worldId, event.seq, event.type, JSON.stringify(event));
    const insertObservation = this.db.prepare("INSERT INTO world_observations(world_id, observer, seq, observation_json) VALUES (?, ?, ?, ?)");
    for (const observation of parsedObservations) {
      if (observation.mode === "heard") {
        const event = this.db.prepare("SELECT kind FROM world_events WHERE world_id = ? AND seq = ?").get(worldId, observation.seq) as { kind: string } | undefined;
        if (event?.kind !== "said") throw new Error("heard observation must refer to a said event");
      }
      insertObservation.run(worldId, observation.observer, observation.seq, JSON.stringify(observation));
    }
    const saveView = this.db.prepare("INSERT INTO world_views(world_id, agent, view_json) VALUES (?, ?, ?) ON CONFLICT(world_id, agent) DO UPDATE SET view_json = excluded.view_json");
    for (const view of parsedViews) saveView.run(worldId, view.agent, JSON.stringify(view));
  }

  getReceipt(requestId: string): { request: string; result: unknown } | null {
    WorldActionId.parse(requestId);
    const row = this.db.prepare("SELECT request, result_json FROM world_receipts WHERE request_id = ?").get(requestId) as { request: string; result_json: string } | undefined;
    return row === undefined ? null : { request: row.request, result: JSON.parse(row.result_json) as unknown };
  }

  putReceipt(requestId: string, request: string, result: unknown): void {
    this.#writing();
    WorldActionId.parse(requestId);
    const json = JSON.stringify(result);
    if (json === undefined) throw new Error("world receipt result must be JSON");
    this.db.prepare("INSERT INTO world_receipts(request_id, request, result_json) VALUES (?, ?, ?)").run(requestId, request, json);
  }

  view(worldId: string, agent: string): WorldResidentView | null {
    WorldId.parse(worldId);
    AgentName.parse(agent);
    const row = this.db.prepare("SELECT view_json FROM world_views WHERE world_id = ? AND agent = ?").get(worldId, agent) as { view_json: string } | undefined;
    return row === undefined ? null : WorldResidentView.parse(JSON.parse(row.view_json));
  }

  observedEvents(worldId: string, agent: string): WorldEvent[] {
    WorldId.parse(worldId);
    AgentName.parse(agent);
    const rows = this.db.prepare(
      "SELECT e.event_json FROM world_observations o JOIN world_events e ON e.world_id = o.world_id AND e.seq = o.seq WHERE o.world_id = ? AND o.observer = ? ORDER BY e.seq ASC",
    ).all(worldId, agent) as { event_json: string }[];
    return rows.map((row) => WorldEvent.parse(JSON.parse(row.event_json)));
  }

  events(worldId: string, before?: number, limit = 50): WorldEventsPage {
    const query = WorldEventsRequest.parse({ type: "world.events", worldId, before, limit });
    const rows = this.db.prepare("SELECT event_json FROM world_events WHERE world_id = ? AND (? IS NULL OR seq < ?) ORDER BY seq DESC LIMIT ?")
      .all(query.worldId, query.before ?? null, query.before ?? null, query.limit + 1) as { event_json: string }[];
    const items = rows.slice(0, query.limit).map((row) => WorldEvent.parse(JSON.parse(row.event_json)));
    return WorldEventsPage.parse({ items, nextBefore: rows.length > query.limit ? items[items.length - 1]!.seq : null });
  }

  scenes(worldId: string, before?: string, limit = 10): WorldScenesPage {
    const query = WorldScenesRequest.parse({ type: "world.scenes", worldId, before, limit });
    const rows = this.db.prepare("SELECT scene_json FROM world_scenes WHERE world_id = ? AND state = 'closed' AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?")
      .all(query.worldId, query.before ?? null, query.before ?? null, query.limit + 1) as { scene_json: string }[];
    const items = rows.slice(0, query.limit).map((row) => WorldScene.parse(JSON.parse(row.scene_json)));
    return WorldScenesPage.parse({ items, nextBefore: rows.length > query.limit ? items[items.length - 1]!.id : null });
  }

  saveScene(worldId: string, scene: WorldScene): void {
    this.#writing();
    WorldId.parse(worldId);
    const parsed = WorldScene.parse(scene);
    this.db.prepare("INSERT INTO world_scenes(world_id, id, state, scene_json) VALUES (?, ?, ?, ?) ON CONFLICT(world_id, id) DO UPDATE SET state = excluded.state, scene_json = excluded.scene_json")
      .run(worldId, parsed.id, parsed.state, JSON.stringify(parsed));
  }

  getScene(worldId: string, sceneId: string): WorldScene | null {
    WorldId.parse(worldId);
    WorldSceneId.parse(sceneId);
    const row = this.db.prepare("SELECT scene_json FROM world_scenes WHERE world_id = ? AND id = ?").get(worldId, sceneId) as { scene_json: string } | undefined;
    return row === undefined ? null : WorldScene.parse(JSON.parse(row.scene_json));
  }

  review(worldId: string, day: number): WorldDayReview | null {
    WorldId.parse(worldId);
    const row = this.db.prepare("SELECT review_json FROM world_reviews WHERE world_id = ? AND day = ?").get(worldId, day) as { review_json: string } | undefined;
    return row === undefined ? null : WorldDayReview.parse(JSON.parse(row.review_json));
  }

  saveReview(worldId: string, review: WorldDayReview): void {
    this.#writing();
    WorldId.parse(worldId);
    const parsed = WorldDayReview.parse(review);
    this.db.prepare("INSERT INTO world_reviews(world_id, day, review_json) VALUES (?, ?, ?) ON CONFLICT(world_id, day) DO UPDATE SET review_json = excluded.review_json")
      .run(worldId, parsed.day, JSON.stringify(parsed));
  }
}

function snapshotJson(world: WorldSnapshot): string {
  const { generation: _generation, ...persisted } = world;
  return JSON.stringify(persisted);
}

// Keep the native connection alive until explicit release, even if a caller drops its callback.
const worldLocks = new Map<string, Database.Database>();

/**
 * A separate SQLite connection holds an OS-backed lock for the scheduler lifetime.
 * Never unlink this file: its existence is not ownership, and the OS releases locks after a crash.
 * Pause and backup retain this handle; only dispose/database switching releases it.
 */
export function acquireWorldLock(dbPath: string): () => void {
  const canonical = realpathSync.native(dbPath);
  const stat = statSync(canonical);
  if (!stat.isFile() || stat.nlink > 1) throw new Error("world database must be a regular file without hard links");
  const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
  if (worldLocks.has(key)) throw new Error("world database is already locked in this process");
  const lock = new Database(canonical + ".world-lock.sqlite", { timeout: 0 });
  try {
    lock.pragma("busy_timeout = 0");
    lock.pragma("journal_mode = DELETE");
    lock.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    lock.close();
    throw error;
  }
  worldLocks.set(key, lock);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { lock.exec("ROLLBACK"); }
    finally {
      try { lock.close(); }
      finally { if (worldLocks.get(key) === lock) worldLocks.delete(key); }
    }
  };
}
