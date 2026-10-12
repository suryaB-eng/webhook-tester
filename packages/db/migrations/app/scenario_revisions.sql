ALTER TABLE scenarios ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision > 0);
