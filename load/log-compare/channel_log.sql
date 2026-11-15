-- Independent positions for every operation; messages is current state.
CREATE TABLE channel_log (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    position bigint NOT NULL CHECK (position > 0),
    message_id uuid NOT NULL,
    version bigint NOT NULL,
    kind text NOT NULL CHECK (kind IN ('Create', 'Edit', 'Move', 'Delete')),
    payload jsonb,
    PRIMARY KEY (organization_id, channel_id, position),
    FOREIGN KEY (organization_id, channel_id, message_id)
        REFERENCES messages (organization_id, channel_id, id)
);
