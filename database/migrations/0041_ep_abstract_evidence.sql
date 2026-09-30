-- Private abstract projections of the existing material identity/version.
-- No public view, record, permission, task or revision draft is changed.
CREATE TABLE ep_research_abstract_fragments (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES ep_research_materials(id) ON DELETE CASCADE,
  material_hash text NOT NULL CHECK (material_hash ~ '^[0-9a-f]{64}$'),
  split_rule_version text NOT NULL CHECK (split_rule_version ~ '^[a-z][a-z0-9_-]{0,79}$'),
  ordinal integer NOT NULL CHECK (ordinal > 0),
  section_label text CHECK (section_label IS NULL OR length(section_label) BETWEEN 1 AND 200),
  material_scope text NOT NULL DEFAULT 'abstract' CHECK (material_scope = 'abstract'),
  fragment_text text NOT NULL CHECK (length(btrim(fragment_text)) BETWEEN 1 AND 100000),
  fragment_hash text NOT NULL CHECK (fragment_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (material_id, material_hash, split_rule_version, ordinal)
);
CREATE INDEX ep_abstract_fragment_material_idx ON ep_research_abstract_fragments(material_id);

-- The database manifest is authoritative. Caller-supplied fragment lists are
-- not used when validating citations. Bundles grant no processing permission.
CREATE TABLE ep_research_abstract_bundles (
  id uuid PRIMARY KEY,
  material_id uuid NOT NULL REFERENCES ep_research_materials(id) ON DELETE CASCADE,
  material_hash text NOT NULL CHECK (material_hash ~ '^[0-9a-f]{64}$'),
  split_rule_version text NOT NULL CHECK (split_rule_version ~ '^[a-z][a-z0-9_-]{0,79}$'),
  state text NOT NULL CHECK (state IN ('ready', 'empty_abstract', 'no_fragments_selected')),
  source jsonb NOT NULL CHECK (jsonb_typeof(source) = 'object'),
  provided_fragment_ids jsonb NOT NULL CHECK (jsonb_typeof(provided_fragment_ids) = 'array'),
  manifest_hash text NOT NULL CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'ready') = (jsonb_array_length(provided_fragment_ids) > 0))
);
CREATE INDEX ep_abstract_bundle_material_idx ON ep_research_abstract_bundles(material_id);
