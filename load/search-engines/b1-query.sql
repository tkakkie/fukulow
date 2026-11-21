WITH visible AS MATERIALIZED (
    SELECT c.id FROM public.channels c
    JOIN public.users u ON u.organization_id = c.organization_id AND u.id = {{actor}}
    LEFT JOIN public.channel_members cm ON cm.organization_id = c.organization_id AND cm.channel_id = c.id
      AND cm.member_id = u.id AND cm.membership_revision = u.membership_revision
    WHERE c.organization_id = public.fukulow_current_org() AND u.deactivated_at IS NULL
      AND ((c.visibility = 'public' AND u.role IN ('owner', 'admin', 'member'))
        OR (u.role IN ('owner', 'admin', 'member', 'guest') AND cm.grant_id IS NOT NULL))
)
SELECT {{columns}} FROM public.messages m
WHERE m.organization_id = public.fukulow_current_org()
  AND m.channel_id = ANY (ARRAY(SELECT v.id FROM visible v))
  AND m.created_at >= TIMESTAMPTZ '2026-11-15 00:00:00+00' - INTERVAL '180 days'
  AND m.created_at <= TIMESTAMPTZ '2026-11-15 00:00:00+00'
ORDER BY {{order}}
