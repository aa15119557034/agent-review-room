/** World history is kept per game; runtime locks and cognition budgets are not part of this database. */
export const SCHEMA_V27 = `
CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  rules_version TEXT NOT NULL,
  initial_json TEXT NOT NULL CHECK (json_valid(initial_json)),
  current_json TEXT NOT NULL CHECK (json_valid(current_json))
);
CREATE TABLE world_settings (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  settings_json TEXT NOT NULL CHECK (json_valid(settings_json))
);
CREATE TABLE world_active (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  world_id TEXT NOT NULL REFERENCES worlds(id)
);
CREATE TABLE world_events (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  seq INTEGER NOT NULL CHECK (seq > 0),
  kind TEXT NOT NULL,
  event_json TEXT NOT NULL CHECK (json_valid(event_json)),
  PRIMARY KEY (world_id, seq)
);
CREATE UNIQUE INDEX world_activity_ended_once
  ON world_events(world_id, json_extract(event_json, '$.activity.id')) WHERE kind = 'activity_ended';
CREATE TRIGGER world_events_contiguous BEFORE INSERT ON world_events
WHEN NEW.seq != COALESCE((SELECT MAX(seq) FROM world_events WHERE world_id = NEW.world_id), 0) + 1
BEGIN SELECT RAISE(ABORT, 'world event sequence must be contiguous'); END;
CREATE TRIGGER world_events_no_update BEFORE UPDATE ON world_events
BEGIN SELECT RAISE(ABORT, 'world events are immutable'); END;
CREATE TRIGGER world_events_no_delete BEFORE DELETE ON world_events
BEGIN SELECT RAISE(ABORT, 'world events are immutable'); END;
CREATE TRIGGER worlds_initial_immutable BEFORE UPDATE OF id, rules_version, initial_json ON worlds
BEGIN SELECT RAISE(ABORT, 'world initial state and rules are immutable'); END;
CREATE TABLE world_observations (
  world_id TEXT NOT NULL,
  observer TEXT NOT NULL,
  seq INTEGER NOT NULL,
  observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
  PRIMARY KEY (world_id, observer, seq),
  FOREIGN KEY (world_id, seq) REFERENCES world_events(world_id, seq)
);
CREATE TABLE world_views (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  agent TEXT NOT NULL,
  view_json TEXT NOT NULL CHECK (json_valid(view_json)),
  PRIMARY KEY (world_id, agent)
);
CREATE TABLE world_receipts (
  request_id TEXT PRIMARY KEY,
  request TEXT NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json))
);
CREATE TRIGGER world_receipts_no_update BEFORE UPDATE ON world_receipts
BEGIN SELECT RAISE(ABORT, 'world receipts are immutable'); END;
CREATE TABLE world_scenes (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open', 'waiting', 'closed')),
  scene_json TEXT NOT NULL CHECK (json_valid(scene_json)),
  PRIMARY KEY (world_id, id)
);
CREATE INDEX world_closed_scenes ON world_scenes(world_id, id DESC) WHERE state = 'closed';
CREATE TABLE world_reviews (
  world_id TEXT NOT NULL REFERENCES worlds(id),
  day INTEGER NOT NULL CHECK (day > 0),
  review_json TEXT NOT NULL CHECK (json_valid(review_json)),
  PRIMARY KEY (world_id, day)
);
`;
