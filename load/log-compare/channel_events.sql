-- Creations remain in messages.seq; only changes occupy this table.
CREATE TABLE channel_events (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    position bigint NOT NULL CHECK (position > 0),
    message_id uuid NOT NULL,
    version bigint NOT NULL,
    kind text NOT NULL CHECK (kind IN ('Edit', 'Move', 'Delete')),
    payload jsonb,
    PRIMARY KEY (organization_id, channel_id, position),
    FOREIGN KEY (organization_id, channel_id, message_id)
        REFERENCES messages (organization_id, channel_id, id)
);
-- Snapshot creations must also survive subsequent state edits/deletes.
-- This table is created only for the snapshot arm (driver substitution).
/* SNAPSHOTS */
