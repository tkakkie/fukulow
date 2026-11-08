CREATE TABLE channel_message_sequences (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    seq bigint NOT NULL CHECK (seq >= 1),
    PRIMARY KEY (organization_id, channel_id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id)
);

CREATE TABLE messages (
    organization_id uuid NOT NULL,
    id uuid NOT NULL,
    channel_id uuid NOT NULL,
    seq bigint NOT NULL CHECK (seq >= 1),
    sender uuid NOT NULL,
    client_message_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, channel_id, seq),
    UNIQUE (organization_id, sender, client_message_id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id),
    FOREIGN KEY (organization_id, sender) REFERENCES users (organization_id, id)
);
