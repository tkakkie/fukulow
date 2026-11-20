{{visibility}}
SELECT {{columns}}
FROM visible v
CROSS JOIN LATERAL (
    SELECT m.id, m.created_at, m.body
    FROM public.messages m
    WHERE m.organization_id = public.fukulow_current_org()
      AND m.channel_id = v.id AND {{matches}}
    {{scopeLimit}}
    OFFSET 0
) hit
{{order}}
