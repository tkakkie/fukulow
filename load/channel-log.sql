-- Legacy (#515) fixture only. Current schemas derive Create from messages.
INSERT INTO channel_log (organization_id, channel_id, event_seq, kind, message_id, sender, client_message_id)
SELECT m.organization_id, m.channel_id, m.seq, 'create', m.id, m.sender, m.client_message_id
FROM messages m
WHERE m.organization_id = $1 AND m.channel_id = ANY($2)
    AND NOT EXISTS (
        SELECT 1 FROM channel_log l
        WHERE l.organization_id = m.organization_id AND l.channel_id = m.channel_id AND l.event_seq = m.seq
    )
