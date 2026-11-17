CREATE TABLE channel_log (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    event_seq bigint NOT NULL CHECK (event_seq > 0),
    kind text NOT NULL CHECK (kind = 'create'),
    message_id uuid NOT NULL,
    sender uuid NOT NULL,
    client_message_id uuid NOT NULL,
    PRIMARY KEY (organization_id, channel_id, event_seq),
    FOREIGN KEY (organization_id, channel_id)
        REFERENCES channels (organization_id, id),
    FOREIGN KEY (organization_id, sender)
        REFERENCES users (organization_id, id)
);

-- Message identity deliberately has no state FK: deleting state must preserve
-- positions. The existing send identity is (Organization, sender, client id).
INSERT INTO channel_log (organization_id, channel_id, event_seq, kind, message_id, sender, client_message_id)
    SELECT organization_id, channel_id, seq, 'create', id, sender, client_message_id FROM messages;

ALTER TABLE channel_log ENABLE ROW LEVEL SECURITY;
-- Append-only even if the separate grants step has not run yet: with no
-- UPDATE or DELETE policy, those statements match no rows.
CREATE POLICY org_read ON channel_log FOR SELECT
    USING (organization_id = fukulow_current_org());
CREATE POLICY org_append ON channel_log FOR INSERT
    WITH CHECK (organization_id = fukulow_current_org());
