/** P2-S07b: keep research authorization and originals on the existing snapshot / run. */
export const SCHEMA_V29 = `
ALTER TABLE prompt_snapshots ADD COLUMN research_plan TEXT CHECK (research_plan IS NULL OR json_valid(research_plan));
ALTER TABLE prompt_snapshots ADD COLUMN research_hash TEXT CHECK (research_hash IS NULL OR (length(research_hash) = 64 AND research_hash NOT GLOB '*[^0-9a-f]*'));
ALTER TABLE runs ADD COLUMN research_original_message_id TEXT REFERENCES messages(id) ON DELETE RESTRICT;

CREATE TRIGGER research_original_matches_run BEFORE UPDATE OF research_original_message_id ON runs
WHEN NEW.research_original_message_id IS NOT OLD.research_original_message_id AND (
  OLD.research_original_message_id IS NOT NULL OR
  NEW.state != 'RUNNING' OR
  NOT EXISTS (SELECT 1 FROM messages m JOIN prompt_snapshots s ON s.id = NEW.snapshot_id
    WHERE m.id = NEW.research_original_message_id AND m.project_id = NEW.project_id
      AND m.kind = 'source_input' AND s.adapter_version = 'project-research-v1'
      AND s.research_plan IS NOT NULL AND s.research_hash IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'research original must be committed once to its own running project');
END;
`;
