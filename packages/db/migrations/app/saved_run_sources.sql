ALTER TABLE runs
  ADD COLUMN source_run_id uuid REFERENCES runs(id),
  ADD COLUMN target_override text CHECK (target_override IS NULL OR length(target_override) BETWEEN 1 AND 100),
  ADD CONSTRAINT runs_source_pair CHECK ((source_run_id IS NULL) = (target_override IS NULL)),
  ADD CONSTRAINT runs_source_distinct CHECK (source_run_id IS NULL OR source_run_id <> id);

CREATE INDEX runs_history ON runs(created_at DESC,id DESC);
CREATE INDEX runs_source ON runs(source_run_id) WHERE source_run_id IS NOT NULL;
-- Existing column-level UPDATE grants deliberately exclude snapshots and lineage.
