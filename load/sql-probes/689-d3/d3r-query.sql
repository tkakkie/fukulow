{{visibility}}
SELECT {{columns}}
FROM visible v
CROSS JOIN LATERAL (
    SELECT t.message_id AS id, t.created_at, checked.body
    FROM public.search_terms_recent t
    CROSS JOIN LATERAL (
        SELECT m.body
        FROM public.messages m
        WHERE m.organization_id = public.fukulow_current_org()
          AND m.id = t.message_id AND m.channel_id = v.id
          AND m.created_at = t.created_at AND {{matches}}
        OFFSET 0
    ) checked
    WHERE t.organization_id = public.fukulow_current_org()
      AND t.channel_id = v.id AND t.term = {{gram}}
    {{scopeLimit}}
    OFFSET 0
) hit
{{scopeFilter}}
{{order}}
