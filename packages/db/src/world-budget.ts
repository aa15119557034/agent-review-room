import Database from "better-sqlite3";
import { RunId, WorldBudget, WorldSceneId, WORLD_SCENE_MAX_MODEL_TURNS } from "@room/schemas";

const APPLICATION_ID = 0x57554247;
const SCHEMA_VERSION = 1;

/** Machine-local usage ledger. Its file must stay outside world saves and backups. */
export class WorldBudgetStore {
  readonly #db: Database.Database;

  constructor(filePath: string) {
    if (filePath === "" || filePath === ":memory:") throw new Error("world budget requires a persistent sidecar file");
    this.#db = new Database(filePath, { timeout: 5000 });
    try {
      // Dispatch is only allowed after a durable commit, unlike ordinary room.db writes.
      this.#db.pragma("synchronous = FULL");
      this.#db.transaction(() => {
        const applicationId = this.#db.pragma("application_id", { simple: true });
        const version = this.#db.pragma("user_version", { simple: true });
        if (applicationId === APPLICATION_ID && version === SCHEMA_VERSION) return;
        const existing = this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get();
        if (applicationId !== 0 || version !== 0 || existing !== undefined) throw new Error("not a supported world budget ledger");
        this.#db.exec(`
          CREATE TABLE world_cognition_reservations (
            run_id TEXT PRIMARY KEY NOT NULL,
            agent TEXT NOT NULL,
            day TEXT NOT NULL,
            scene_id TEXT,
            reserved_at TEXT NOT NULL
          );
          CREATE INDEX world_cognition_daily ON world_cognition_reservations(agent, day);
          CREATE INDEX world_cognition_scene ON world_cognition_reservations(scene_id) WHERE scene_id IS NOT NULL;
        `);
        this.#db.pragma("application_id = " + APPLICATION_ID);
        this.#db.pragma("user_version = " + SCHEMA_VERSION);
      }).immediate();
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  get(agent: string, limit: number, now: Date = new Date()): WorldBudget {
    return this.#budget(period(agent, limit, now));
  }

  sceneUsed(sceneId: string): number {
    const row = this.#db.prepare("SELECT COUNT(*) AS used FROM world_cognition_reservations WHERE scene_id = ?")
      .get(WorldSceneId.parse(sceneId)) as { used: number };
    return row.used;
  }

  reserve(input: { runId: string; agent: string; sceneId?: string | null; limit: number; now?: Date }): { accepted: boolean; budget: WorldBudget; reason?: "budget" | "scene" } {
    const runId = RunId.parse(input.runId);
    const sceneId = input.sceneId == null ? null : WorldSceneId.parse(input.sceneId);
    const now = input.now ?? new Date();
    const current = period(input.agent, input.limit, now);
    // BEGIN IMMEDIATE serializes the checks and insertion across all connections/processes.
    return this.#db.transaction(() => {
      const previous = this.#db.prepare("SELECT agent, scene_id FROM world_cognition_reservations WHERE run_id = ?").get(runId) as { agent: string; scene_id: string | null } | undefined;
      const budget = this.#budget(current);
      if (previous !== undefined) {
        if (previous.agent !== current.agent || previous.scene_id !== sceneId) throw new Error("world cognition Run already belongs to another agent or scene");
        return { accepted: true, budget };
      }
      if (budget.used >= budget.limit) return { accepted: false, budget, reason: "budget" as const };
      if (sceneId !== null && this.sceneUsed(sceneId) >= WORLD_SCENE_MAX_MODEL_TURNS) return { accepted: false, budget, reason: "scene" as const };
      this.#db.prepare("INSERT INTO world_cognition_reservations(run_id, agent, day, scene_id, reserved_at) VALUES (?, ?, ?, ?, ?)")
        .run(runId, current.agent, current.day, sceneId, now.toISOString());
      return { accepted: true, budget: this.#budget(current) };
    }).immediate();
  }

  close(): void { if (this.#db.open) this.#db.close(); }

  #budget(current: WorldBudget): WorldBudget {
    const row = this.#db.prepare("SELECT COUNT(*) AS used FROM world_cognition_reservations WHERE agent = ? AND day = ?").get(current.agent, current.day) as { used: number };
    return WorldBudget.parse({ ...current, used: row.used });
  }
}

function period(agent: string, limit: number, now: Date): WorldBudget {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid world budget date");
  const day = [String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return WorldBudget.parse({ agent, day, used: 0, limit, resetsAt: next.toISOString() });
}
