-- Additive, private extraction only. Existing public views/records are untouched.
ALTER TABLE receipts ADD COLUMN retry_policy text NOT NULL DEFAULT 'existing'
  CHECK (retry_policy IN ('existing', 'never'));

-- A human authorization identifies ONE round. Restarting a script cannot reset
-- the money reservation or execution count. Unknown/crashed rounds keep both.
CREATE TABLE ep_research_extraction_trials (
  id uuid PRIMARY KEY,
  authorization_key text NOT NULL UNIQUE CHECK (length(authorization_key) BETWEEN 1 AND 200),
  bundle_id uuid NOT NULL REFERENCES ep_research_abstract_bundles(id),
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  model_key text NOT NULL,
  model_name text NOT NULL,
  endpoint text NOT NULL,
  approval jsonb NOT NULL CHECK (jsonb_typeof(approval) = 'object'),
  currency text NOT NULL CHECK (currency IN ('USD', 'CNY')),
  authorized_micros bigint NOT NULL CHECK (authorized_micros > 0),
  reserved_micros bigint NOT NULL CHECK (reserved_micros > 0 AND reserved_micros <= authorized_micros),
  execution_count integer NOT NULL DEFAULT 0 CHECK (execution_count IN (0, 1)),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','in_flight','received','invalid_output','unknown','rejected')),
  receipt_id bigint REFERENCES receipts(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ep_research_extraction_drafts (
  id uuid PRIMARY KEY,
  bundle_id uuid NOT NULL REFERENCES ep_research_abstract_bundles(id),
  input_manifest jsonb NOT NULL CHECK (jsonb_typeof(input_manifest) = 'object'),
  origin text NOT NULL CHECK (origin IN ('offline_fixed','live')),
  trial_id uuid REFERENCES ep_research_extraction_trials(id),
  receipt_id bigint REFERENCES receipts(id),
  raw_output jsonb,
  parsed_output jsonb,
  format_status text NOT NULL CHECK (format_status IN ('valid','invalid','not_received')),
  citation_status text NOT NULL CHECK (citation_status IN ('valid','invalid','not_checked')),
  semantic_status text NOT NULL DEFAULT 'not_performed' CHECK (semantic_status = 'not_performed'),
  state text NOT NULL CHECK (state IN ('private_draft','invalid_output','unknown','empty_input')),
  issues jsonb NOT NULL CHECK (jsonb_typeof(issues) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((origin = 'live') = (trial_id IS NOT NULL))
);
CREATE INDEX ep_extraction_draft_bundle_idx ON ep_research_extraction_drafts(bundle_id);
