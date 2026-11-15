CREATE TABLE message_mentions (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    message_id uuid NOT NULL,
    member_id uuid NOT NULL,
    PRIMARY KEY (organization_id, message_id, member_id),
    FOREIGN KEY (organization_id, channel_id, message_id)
        REFERENCES messages (organization_id, channel_id, id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id, member_id)
        REFERENCES users (organization_id, id)
);

CREATE INDEX message_mentions_member_channel_message
    ON message_mentions (organization_id, member_id, channel_id, message_id);
CREATE INDEX message_mentions_channel_message
    ON message_mentions (organization_id, channel_id, message_id);

ALTER TABLE message_mentions ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON message_mentions FOR ALL
    USING (organization_id = fukulow_current_org())
    WITH CHECK (organization_id = fukulow_current_org());
