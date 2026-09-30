-- PR2A: private source snapshots and explicit revision drafts.
-- Existing research records, findings and public views remain unchanged.

CREATE TABLE ep_research_external_ids (
  kind text NOT NULL CHECK (kind IN ('doi', 'pmid')),
  value text NOT NULL,
  record_id uuid NOT NULL REFERENCES ep_research_records(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, value),
  CHECK ((kind = 'doi' AND value = lower(value) AND value ~ '^10\.[0-9]{4,9}/[^[:space:]]+$')
      OR (kind = 'pmid' AND value ~ '^[1-9][0-9]{0,11}$'))
);
CREATE INDEX ep_research_external_ids_record_idx ON ep_research_external_ids(record_id);

-- Existing PR1 DOI identities must participate in PR2A duplicate resolution.
INSERT INTO ep_research_external_ids (kind, value, record_id)
SELECT 'doi', doi, id FROM ep_research_records WHERE doi IS NOT NULL;
INSERT INTO ep_research_external_ids (kind, value, record_id)
SELECT 'pmid', substring(source_key FROM 6), id
FROM ep_research_records WHERE source_key ~ '^pmid:[1-9][0-9]{0,11}$';

-- One immutable normalized snapshot per provider version. The abstract stays
-- private here; even a linked material has no public projection.
CREATE TABLE ep_research_materials (
  id uuid PRIMARY KEY,
  record_id uuid REFERENCES ep_research_records(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('crossref', 'pubmed')),
  provider_id text NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1000),
  source_url text NOT NULL CHECK (source_url ~ '^https?://'),
  acquired_at timestamptz NOT NULL,
  material_scope text NOT NULL CHECK (material_scope IN ('metadata', 'abstract')),
  version_label text CHECK (version_label IS NULL OR length(version_label) <= 200),
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  intake_state text NOT NULL CHECK (intake_state IN ('linked', 'needs_metadata', 'identity_conflict')),
  conflict_details jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(conflict_details) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_id, payload_hash),
  UNIQUE (id, record_id),
  CHECK ((intake_state = 'linked') = (record_id IS NOT NULL))
);
CREATE INDEX ep_research_materials_record_idx ON ep_research_materials(record_id, acquired_at DESC);
CREATE INDEX ep_research_materials_staged_idx ON ep_research_materials(provider, provider_id)
  WHERE record_id IS NULL;

-- A material attached to an existing record only proposes a change. Applying
-- or rejecting it requires a separate, reviewed operation in a later PR.
CREATE TABLE ep_research_revision_drafts (
  id uuid PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES ep_research_records(id) ON DELETE CASCADE,
  material_id uuid NOT NULL UNIQUE,
  base_input_hash text NOT NULL CHECK (base_input_hash ~ '^[0-9a-f]{64}$'),
  proposed_metadata jsonb NOT NULL CHECK (jsonb_typeof(proposed_metadata) = 'object'),
  conflicting_fields text[] NOT NULL DEFAULT '{}',
  state text NOT NULL DEFAULT 'draft' CHECK (state = 'draft'),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (material_id, record_id) REFERENCES ep_research_materials(id, record_id)
);
CREATE INDEX ep_research_revision_drafts_record_idx ON ep_research_revision_drafts(record_id, created_at DESC);
