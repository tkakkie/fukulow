{{visibility}}
SELECT {{columns}}
FROM visible v
CROSS JOIN LATERAL (
    SELECT t.message_id
    FROM public.search_terms t
    WHERE t.organization_id = public.fukulow_current_org()
      AND t.scope_term = v.id::text || ':' || {{gram}}
    OFFSET 0
) candidate
CROSS JOIN LATERAL (
    SELECT m.id, m.created_at, m.body
    FROM public.messages m
    WHERE m.organization_id = public.fukulow_current_org()
      AND m.id = candidate.message_id AND m.channel_id = v.id
      AND {{matches}}
    OFFSET 0
) hit
{{order}}
