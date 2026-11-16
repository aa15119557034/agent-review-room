import { StructuredAgentEvent, TERMINAL_EVENT_TYPES } from "@room/schemas";

const eventTypes = StructuredAgentEvent.options.map((option) => `'${option.shape.type.value}'`).join(", ");
const terminalTypes = TERMINAL_EVENT_TYPES.map((type) => `'${type}'`).join(", ");
const sourceRefs = `TEXT CHECK (source_refs IS NULL OR
  (json_valid(source_refs) AND json_type(source_refs) = 'array' AND json_array_length(source_refs) BETWEEN 1 AND 100))`;

/** P2-D08: metadata stays on its original immutable record; both Run kinds use the existing event store. */
export const SCHEMA_V28 = `
ALTER TABLE messages ADD COLUMN source_refs ${sourceRefs};
ALTER TABLE prompt_snapshots ADD COLUMN source_refs ${sourceRefs};
ALTER TABLE chat_messages ADD COLUMN source_refs ${sourceRefs};
ALTER TABLE chat_snapshots ADD COLUMN source_refs ${sourceRefs};

CREATE TRIGGER chat_message_sources_immutable BEFORE UPDATE OF source_refs ON chat_messages
WHEN NEW.source_refs IS NOT OLD.source_refs
BEGIN SELECT RAISE(ABORT, 'chat message sources are immutable'); END;
CREATE TRIGGER user_chat_messages_have_no_sources BEFORE INSERT ON chat_messages
WHEN NEW.sender = 'user' AND NEW.source_refs IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'user chat messages cannot supply source references'); END;

CREATE TABLE run_events_v28 (
  run_id TEXT REFERENCES runs(id) ON DELETE RESTRICT,
  chat_run_id TEXT REFERENCES chat_runs(id) ON DELETE RESTRICT,
  seq INTEGER NOT NULL CHECK (seq >= 0),
  event_id TEXT NOT NULL PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN (${eventTypes})),
  payload TEXT NOT NULL CHECK (json_valid(payload)),
  ts TEXT NOT NULL,
  CHECK ((run_id IS NOT NULL) != (chat_run_id IS NOT NULL)),
  UNIQUE(run_id, seq),
  UNIQUE(chat_run_id, seq)
) STRICT;
INSERT INTO run_events_v28 (run_id, seq, event_id, type, payload, ts)
  SELECT run_id, seq, event_id, type, payload, ts FROM run_events;
DROP TABLE run_events;
ALTER TABLE run_events_v28 RENAME TO run_events;
CREATE UNIQUE INDEX ux_run_events_terminal ON run_events(run_id) WHERE type IN (${terminalTypes});
CREATE UNIQUE INDEX ux_chat_run_events_terminal ON run_events(chat_run_id) WHERE type IN (${terminalTypes});
CREATE TRIGGER run_events_no_update BEFORE UPDATE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events are append-only'); END;
CREATE TRIGGER run_events_no_delete BEFORE DELETE ON run_events
BEGIN SELECT RAISE(ABORT, 'run_events are append-only'); END;
`;
