-- #314 step 4: Row-Level Security as tenant-isolation defense in depth.
-- Applies to non-owner, non-superuser roles (fukulow_app). Owner jobs stay
-- unrestricted (ENABLE without FORCE; the owner is a superuser).

-- Transaction-local context. Unset or empty is NULL, so comparisons fail closed;
-- a malformed value raises instead of matching.
CREATE FUNCTION fukulow_current_org() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('fukulow.organization_id', true), '')::uuid $$;

CREATE FUNCTION fukulow_current_account() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT NULLIF(current_setting('fukulow.account_id', true), '')::uuid $$;

-- Global bootstrap exception: exposes only whether any Organization exists.
-- EXECUTE is revoked from PUBLIC here and granted to fukulow_app in db-grants.sql.
CREATE FUNCTION fukulow_setup_required() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$ SELECT NOT EXISTS (SELECT 1 FROM public.organizations) $$;
REVOKE ALL ON FUNCTION fukulow_setup_required() FROM PUBLIC;

ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_message_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE channel_read_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE topic_read_positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE invites ENABLE ROW LEVEL SECURITY;

CREATE POLICY org_isolation ON organizations FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON users FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON channels FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON channel_members FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON channel_message_sequences FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON messages FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON topics FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON channel_read_positions FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON topic_read_positions FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
CREATE POLICY org_isolation ON invites FOR ALL
    USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());

-- Account context (after AccountAuth or verified sign-in): read-only access to
-- the caller's own Members and their Organizations, never writes.
CREATE POLICY account_read ON users FOR SELECT
    USING (account_id = fukulow_current_account());
CREATE POLICY account_read ON organizations FOR SELECT
    USING (EXISTS (SELECT 1 FROM users u
                   WHERE u.organization_id = organizations.organization_id
                     AND u.account_id = fukulow_current_account()));
