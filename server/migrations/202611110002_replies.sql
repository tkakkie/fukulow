ALTER TABLE messages ADD COLUMN reply_to_id uuid NULL;
ALTER TABLE messages ADD COLUMN reply_root_id uuid NULL;
CREATE UNIQUE INDEX messages_channel_id ON messages (organization_id, channel_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_reply_parent_channel_fk
    FOREIGN KEY (organization_id, channel_id, reply_to_id)
    REFERENCES messages (organization_id, channel_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_reply_root_channel_fk
    FOREIGN KEY (organization_id, channel_id, reply_root_id)
    REFERENCES messages (organization_id, channel_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_reply_not_self CHECK (reply_to_id <> id);
ALTER TABLE messages ADD CONSTRAINT messages_reply_pair
    CHECK ((reply_to_id IS NULL) = (reply_root_id IS NULL));

CREATE INDEX messages_reply_chain_seq
    ON messages (organization_id, channel_id, reply_root_id, seq);
