CREATE TABLE channels (
    organization_id uuid NOT NULL REFERENCES organizations (organization_id),
    id uuid NOT NULL,
    name text NOT NULL,
    visibility text NOT NULL CHECK (visibility IN ('public', 'private')),
    PRIMARY KEY (organization_id, id)
);

CREATE TABLE channel_members (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    member_id uuid NOT NULL,
    PRIMARY KEY (organization_id, channel_id, member_id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id),
    FOREIGN KEY (organization_id, member_id) REFERENCES users (organization_id, id)
);
CREATE INDEX channel_members_by_member ON channel_members (organization_id, member_id, channel_id);
