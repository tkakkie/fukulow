-- Use existing Messages so the database still has 24,007 rows.
-- 24 tied hits in scope 1 and four in each of scopes 2 and 3.
UPDATE public.messages
SET body = body || ' tiemark', created_at = '2026-11-14 00:00:00+00'
WHERE organization_id = probe_org(1)
  AND (id BETWEEN 102001 AND 102024 OR id BETWEEN 104001 AND 104004 OR id BETWEEN 106001 AND 106004);

-- All 26 newer candidates share the first trigram and fail the full LIKE.
UPDATE public.messages
SET body = body || CASE WHEN id <= 108026 THEN ' rqzdecoy' ELSE ' rqzneedle' END
WHERE organization_id = probe_org(1) AND id BETWEEN 108001 AND 108051;
