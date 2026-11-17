-- #153 P2 prototype (measurement only, not a migration): search runs as a
-- dedicated BYPASSRLS definer so LIKE can be an index condition. Under RLS the
-- non-LEAKPROOF textlike operator is never pushed into the search index.
-- Idempotent: reapplied after pg_restore --no-owner --no-acl resets owner/ACLs.
-- Unsafe window: between pg_restore and this file, the function is owned by the
-- restoring superuser (so the body runs as superuser) and executable by PUBLIC.
-- No app connection may use a restored database until this file has run.
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'fukulow_search') THEN
        CREATE ROLE fukulow_search;
    END IF;
    IF EXISTS (SELECT FROM pg_auth_members
               WHERE member = 'fukulow_search'::regrole OR roleid = 'fukulow_search'::regrole) THEN
        RAISE EXCEPTION 'fukulow_search must have no role memberships';
    END IF;
END $$;
ALTER ROLE fukulow_search NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION BYPASSRLS;

-- The Organization comes only from the caller's transaction-local context
-- (NULL or empty: no rows). The acting Member is trusted as in the direct query.
-- An empty query returns no rows. BEGIN ATOMIC binds every object at creation,
-- so the caller's search_path or standard_conforming_strings cannot change the
-- body; the pattern is built here, so a caller can never pass an unescaped or
-- trailing-escape pattern. Only query-path settings are set on the function
-- (planner/executor conditions such as jit stay those of v1):
-- plan_cache_mode=force_custom_plan, because a cached generic plan would keep
-- $2 a parameter, so the LIKE pattern would not fold to a constant (no trigram
-- extraction for estimates), unlike the direct literal query of v1.
-- Pin the creation-time binding, independent of the session's search_path.
SET search_path = pg_catalog, public;
CREATE OR REPLACE FUNCTION public.fukulow_search_messages(actor uuid, query text, page boolean)
RETURNS TABLE (id uuid, created_at timestamptz, body text)
LANGUAGE sql STABLE STRICT SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET plan_cache_mode = force_custom_plan
BEGIN ATOMIC
WITH visible AS MATERIALIZED (
    SELECT c.id FROM public.channels c
    JOIN public.users u ON u.organization_id = c.organization_id AND u.id = $1
    LEFT JOIN public.channel_members cm ON cm.organization_id = c.organization_id AND cm.channel_id = c.id
      AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision
      AND cm.organization_id = public.fukulow_current_org()
    WHERE c.organization_id = public.fukulow_current_org() AND u.organization_id = public.fukulow_current_org()
      AND u.deactivated_at IS NULL AND $2 <> ''
      AND ((c.visibility = 'public' AND u.role IN ('owner', 'admin', 'member'))
        OR (u.role IN ('owner', 'admin', 'member', 'guest') AND cm.grant_id IS NOT NULL))
)
SELECT m.id, m.created_at, m.body FROM visible v
CROSS JOIN LATERAL (
    SELECT m.id, m.created_at, m.body FROM public.messages m
    WHERE m.organization_id = public.fukulow_current_org() AND m.channel_id = v.id
      AND m.created_at >= TIMESTAMPTZ '2026-11-15 00:00:00+00' - INTERVAL '180 days'
      AND m.created_at <= TIMESTAMPTZ '2026-11-15 00:00:00+00'
      AND m.normalized_body LIKE '%' || replace(replace(replace($2, '\', '\\'), '%', '\%'), '_', '\_') || '%' ESCAPE '\'
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT CASE WHEN $3 THEN 20 END OFFSET 0
) m
ORDER BY m.created_at DESC, m.id DESC
LIMIT CASE WHEN $3 THEN 20 END;
END;
ALTER FUNCTION public.fukulow_search_messages(uuid, text, boolean) OWNER TO fukulow_search;
REVOKE ALL ON FUNCTION public.fukulow_search_messages(uuid, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fukulow_search_messages(uuid, text, boolean) TO fukulow_app;

-- SELECT on exactly the columns the body reads; nothing else beyond PUBLIC defaults.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM fukulow_search;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM fukulow_search;
GRANT SELECT (organization_id, id, channel_id, created_at, body, normalized_body) ON public.messages TO fukulow_search;
GRANT SELECT (organization_id, id, visibility) ON public.channels TO fukulow_search;
GRANT SELECT (organization_id, id, role, deactivated_at, membership_revision) ON public.users TO fukulow_search;
GRANT SELECT (organization_id, channel_id, member_id, membership_revision, grant_id) ON public.channel_members TO fukulow_search;
