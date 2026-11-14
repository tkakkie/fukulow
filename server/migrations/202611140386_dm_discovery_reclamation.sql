-- Global maintenance enumerates ids only; all tenant work still uses scoped RLS.
CREATE FUNCTION fukulow_next_maintenance_organization(after_id uuid) RETURNS uuid
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = pg_catalog, pg_temp
    AS $$ SELECT COALESCE(
        (SELECT organization_id FROM public.organizations
         WHERE organization_id > after_id ORDER BY organization_id LIMIT 1),
        (SELECT organization_id FROM public.organizations ORDER BY organization_id LIMIT 1)
    ) $$;
REVOKE ALL ON FUNCTION fukulow_next_maintenance_organization(uuid) FROM PUBLIC;
