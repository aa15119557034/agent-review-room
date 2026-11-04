export const SCHEMA_V25 = `
CREATE TABLE workspace_decisions (
  id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','rejected','deferred')), reason TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id), version INTEGER NOT NULL CHECK(version>0), created_at TEXT NOT NULL,
  PRIMARY KEY(id,version)
) STRICT;
CREATE INDEX idx_workspace_decisions_project ON workspace_decisions(project_id,created_at DESC);
CREATE TRIGGER workspace_decisions_no_update BEFORE UPDATE ON workspace_decisions BEGIN SELECT RAISE(ABORT,'decision history is immutable'); END;
CREATE TRIGGER workspace_decisions_no_delete BEFORE DELETE ON workspace_decisions BEGIN SELECT RAISE(ABORT,'decision history is immutable'); END;
`;
