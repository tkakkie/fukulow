-- Names are unique across public/private Channels within each Organization.
-- C collation folds ASCII letters only and compares non-ASCII characters as-is.
-- Existing duplicates fail this migration: the operator must resolve them and
-- re-run; no Channel is automatically renamed or deleted.
CREATE UNIQUE INDEX channels_organization_name_unique
    ON channels (organization_id, lower(name COLLATE "C"));
