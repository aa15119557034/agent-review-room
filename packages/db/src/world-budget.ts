import Database from "better-sqlite3";
import { IsoTimestamp, NodeBaseUrl, NodeId, ProfileId, RemoteRunLedgerId, RemoteRunProof, RunId, RunModel, WorldBudget, WorldGeneration, WorldId, WorldProfileExpectation, WorldSceneId, WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1, WORLD_SCENE_MAX_MODEL_TURNS } from "@room/schemas";

const APPLICATION_ID = 0x57554247;
const SCHEMA_VERSION = 2;
const BINDING_TABLE = `CREATE TABLE world_cognition_bindings (
  run_id TEXT PRIMARY KEY NOT NULL REFERENCES world_cognition_reservations(run_id),
  binding_json TEXT NOT NULL,
  proof_status TEXT CHECK(proof_status IN ('fenced_never_started', 'closed_process')),
  confirmed_at TEXT,
  CHECK((proof_status IS NULL) = (confirmed_at IS NULL))
);`;

/** Machine-local usage ledger. Its file must stay outside world saves and backups. */
export class WorldBudgetStore {
  readonly #db: Database.Database;

  constructor(filePath: string) {
    if (filePath === "" || filePath === ":memory:") throw new Error("world budget requires a persistent sidecar file");
    this.#db = new Database(filePath, { timeout: 5000 });
    try {
      // Dispatch is only allowed after a durable commit, unlike ordinary room.db writes.
      this.#db.pragma("synchronous = FULL");
      this.#db.pragma("foreign_keys = ON");
      this.#db.transaction(() => {
        const applicationId = this.#db.pragma("application_id", { simple: true });
        const version = this.#db.pragma("user_version", { simple: true });
        if (applicationId === APPLICATION_ID && version === SCHEMA_VERSION) return;
        if (applicationId === APPLICATION_ID && version === 1) {
          // Old reservations have unknown execution scope. Keep them unresolved;
          // migration cannot invent a ledger, recipe or positive stop proof.
          this.#db.exec(BINDING_TABLE);
          this.#db.pragma("user_version = " + SCHEMA_VERSION);
          return;
        }
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
        this.#db.exec(BINDING_TABLE);
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

  /** Persist original dispatch identity in the same commit as its reservation.
   * New dispatches cannot cross another unresolved reservation, across processes. */
  reserveBound(input: Parameters<WorldBudgetStore["reserve"]>[0] & { binding: {
    worldId: string; generation: WorldGeneration; nodeId: string; baseUrl: string; profileId: string;
    ledgerId: RemoteRunLedgerId; worldProfile: WorldProfileExpectation; model: RunModel;
  } }): ReturnType<WorldBudgetStore["reserve"]> | { accepted: false; budget: WorldBudget; reason: "pending" } {
    const runId = RunId.parse(input.runId), parsed = parseBinding(input.binding);
    if (parsed.worldProfile.recipeVersion !== WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1 || parsed.profileId === parsed.worldProfile.sourceChatProfileId) throw new Error("world Run requires a verified isolated profile binding");
    const binding = JSON.stringify(parsed);
    return this.#db.transaction(() => {
      const previous = this.#db.prepare("SELECT r.run_id, b.binding_json FROM world_cognition_reservations r LEFT JOIN world_cognition_bindings b ON b.run_id=r.run_id WHERE r.run_id=?")
        .get(runId) as { run_id: string; binding_json: string | null } | undefined;
      if (previous) {
        if (previous.binding_json !== binding) throw new Error("world Run dispatch binding cannot change or be guessed");
        return this.reserve(input);
      }
      if (this.pending().length > 0) return { accepted: false as const, budget: this.get(input.agent, input.limit, input.now), reason: "pending" as const };
      const reserved = this.reserve(input);
      if (!reserved.accepted) return reserved;
      this.#db.prepare("INSERT INTO world_cognition_bindings(run_id,binding_json) VALUES (?,?)").run(runId, binding);
      return reserved;
    }).immediate();
  }

  pending() {
    const rows = this.#db.prepare(`SELECT r.run_id, r.agent, r.scene_id, r.reserved_at, b.binding_json
      FROM world_cognition_reservations r LEFT JOIN world_cognition_bindings b ON b.run_id=r.run_id
      WHERE b.proof_status IS NULL ORDER BY r.reserved_at, r.run_id`).all() as { run_id: unknown; agent: unknown; scene_id: unknown; reserved_at: unknown; binding_json: string | null }[];
    return rows.map(row => ({ runId: RunId.parse(row.run_id), agent: WorldBudget.shape.agent.parse(row.agent),
      sceneId: row.scene_id === null ? null : WorldSceneId.parse(row.scene_id), reservedAt: IsoTimestamp.parse(row.reserved_at),
      binding: row.binding_json === null ? null : parseBinding(JSON.parse(row.binding_json)),
    }));
  }

  confirmStopped(raw: RemoteRunProof, now: Date = new Date()): void {
    const proof = RemoteRunProof.parse(raw), at = IsoTimestamp.parse(now.toISOString());
    if (proof.status !== "fenced_never_started" && proof.status !== "closed_process") throw new Error("world Run has no positive stop proof");
    this.#db.transaction(() => {
      const row = this.#db.prepare("SELECT binding_json FROM world_cognition_bindings WHERE run_id=?").get(proof.runId) as { binding_json: string } | undefined;
      if (!row) throw new Error("world Run has no recorded dispatch binding");
      const binding = parseBinding(JSON.parse(row.binding_json));
      if (binding.ledgerId !== proof.ledgerId || binding.worldProfile.recipeVersion !== WORLD_PROFILE_RECIPE_DEEPSEEK_HTTP_V1) throw new Error("world Run stop proof does not match its original scope");
      this.#db.prepare("UPDATE world_cognition_bindings SET proof_status=?,confirmed_at=? WHERE run_id=? AND proof_status IS NULL").run(proof.status, at, proof.runId);
    }).immediate();
  }

  close(): void { if (this.#db.open) this.#db.close(); }

  #budget(current: WorldBudget): WorldBudget {
    const row = this.#db.prepare("SELECT COUNT(*) AS used FROM world_cognition_reservations WHERE agent = ? AND day = ?").get(current.agent, current.day) as { used: number };
    return WorldBudget.parse({ ...current, used: row.used });
  }
}

/** Persisted fields use the existing approved schemas; no token or prompt lives here. */
function parseBinding(raw: unknown) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid world dispatch binding");
  const value = raw as Record<string, unknown>;
  const keys = ["worldId", "generation", "nodeId", "baseUrl", "profileId", "ledgerId", "worldProfile", "model"];
  if (Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error("invalid world dispatch binding fields");
  return { worldId: WorldId.parse(value.worldId), generation: WorldGeneration.parse(value.generation),
    nodeId: NodeId.parse(value.nodeId), baseUrl: NodeBaseUrl.parse(value.baseUrl), profileId: ProfileId.parse(value.profileId),
    ledgerId: RemoteRunLedgerId.parse(value.ledgerId), worldProfile: WorldProfileExpectation.parse(value.worldProfile), model: RunModel.parse(value.model),
  };
}

function period(agent: string, limit: number, now: Date): WorldBudget {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid world budget date");
  const day = [String(now.getFullYear()).padStart(4, "0"), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")].join("-");
  const next = new Date(now.getTime());
  next.setDate(next.getDate() + 1);
  next.setHours(0, 0, 0, 0);
  return WorldBudget.parse({ agent, day, used: 0, limit, resetsAt: next.toISOString() });
}
