-- #689 measurement role. LOGIN uses the isolated container's local Unix socket.
BEGIN;
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'fukulow_b1') THEN
        CREATE ROLE fukulow_b1 LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
    END IF;
END $$;
ALTER ROLE fukulow_b1 SET search_path = pg_catalog, pg_temp;
SET LOCAL search_path = pg_catalog, pg_temp;
GRANT USAGE ON SCHEMA public TO fukulow_b1;
GRANT SELECT (organization_id, id, channel_id, created_at, body, normalized_body) ON public.messages TO fukulow_b1;
GRANT SELECT (organization_id, id, visibility) ON public.channels TO fukulow_b1;
GRANT SELECT (organization_id, id, role, deactivated_at, membership_revision) ON public.users TO fukulow_b1;
GRANT SELECT (organization_id, channel_id, member_id, membership_revision, grant_id) ON public.channel_members TO fukulow_b1;

ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.channels FORCE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;
ALTER TABLE public.channel_members FORCE ROW LEVEL SECURITY;

-- org_isolation still applies. NULL or empty query context makes LIKE NULL.
-- Escaping is bound inside the policy, using a literal backslash escape character.
DROP POLICY IF EXISTS b1_match ON public.messages;
CREATE POLICY b1_match ON public.messages AS RESTRICTIVE FOR SELECT TO fukulow_b1 USING (
    normalized_body LIKE '%' ||
        replace(replace(replace(nullif(current_setting('fukulow.search_query', true), ''),
            chr(92), chr(92) || chr(92)), '%', chr(92) || '%'), '_', chr(92) || '_') || '%'
        ESCAPE chr(92)
);
COMMIT;
