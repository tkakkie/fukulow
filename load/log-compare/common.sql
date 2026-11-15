-- Minimal parent fixtures; no authentication, RLS, Mentions or Unread work is
-- claimed. messages/topics/counter constraints and index sets match migrations
-- 202611090002, 202611110001 and 202611110198.
CREATE TABLE channels (
    organization_id uuid NOT NULL, id uuid NOT NULL,
    history_generation uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000160',
    PRIMARY KEY (organization_id, id)
);
CREATE TABLE users (
    organization_id uuid NOT NULL, id uuid NOT NULL,
    PRIMARY KEY (organization_id, id)
);
CREATE TABLE channel_message_sequences (
    organization_id uuid NOT NULL, channel_id uuid NOT NULL,
    seq bigint NOT NULL CHECK (seq >= 1),
    PRIMARY KEY (organization_id, channel_id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id)
);
CREATE TABLE topics (
    organization_id uuid NOT NULL, channel_id uuid NOT NULL, id uuid NOT NULL,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
    name_key text COLLATE "C" GENERATED ALWAYS AS (lower(name COLLATE "C")) STORED,
    first_seq bigint NOT NULL CHECK (first_seq >= 1),
    last_seq bigint NOT NULL CHECK (last_seq >= first_seq),
    message_count bigint NOT NULL CHECK (message_count >= 1),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, channel_id, id),
    UNIQUE (organization_id, channel_id, name_key),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id)
);
CREATE TABLE messages (
    organization_id uuid NOT NULL, id uuid NOT NULL, channel_id uuid NOT NULL,
    seq bigint NOT NULL CHECK (seq >= 1), sender uuid NOT NULL,
    client_message_id uuid NOT NULL, body text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    topic_id uuid, reply_to_id uuid, reply_root_id uuid,
    version bigint NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false,
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, channel_id, seq),
    UNIQUE (organization_id, sender, client_message_id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id),
    FOREIGN KEY (organization_id, sender) REFERENCES users (organization_id, id),
    CONSTRAINT messages_topic_channel_fk FOREIGN KEY (organization_id, channel_id, topic_id)
        REFERENCES topics (organization_id, channel_id, id),
    CONSTRAINT messages_reply_not_self CHECK (reply_to_id <> id),
    CONSTRAINT messages_reply_pair CHECK ((reply_to_id IS NULL) = (reply_root_id IS NULL))
);
CREATE INDEX messages_topic_seq ON messages (organization_id, channel_id, topic_id, seq);
CREATE UNIQUE INDEX messages_org_channel_id_key ON messages (organization_id, channel_id, id);
ALTER TABLE messages ADD CONSTRAINT messages_reply_parent_channel_fk FOREIGN KEY (organization_id, channel_id, reply_to_id)
        REFERENCES messages (organization_id, channel_id, id),
    ADD CONSTRAINT messages_reply_root_channel_fk FOREIGN KEY (organization_id, channel_id, reply_root_id)
        REFERENCES messages (organization_id, channel_id, id);
CREATE INDEX messages_reply_chain_seq ON messages (organization_id, channel_id, reply_root_id, seq)
    WHERE reply_root_id IS NOT NULL;
-- A digest validates original send intent after mutation without retaining a body.
CREATE TABLE send_receipts (
    organization_id uuid NOT NULL, sender uuid NOT NULL, client_message_id uuid NOT NULL,
    message_id uuid NOT NULL, original_seq bigint NOT NULL, request_hash bytea NOT NULL,
    PRIMARY KEY (organization_id, sender, client_message_id),
    FOREIGN KEY (organization_id, message_id) REFERENCES messages (organization_id, id)
);
CREATE FUNCTION fixture_id(c bigint, n bigint) RETURNS uuid LANGUAGE sql IMMUTABLE AS
$$ SELECT md5(c::text || '/' || n::text)::uuid $$;
CREATE FUNCTION fixture_body(n bigint, scalars integer) RETURNS text LANGUAGE sql IMMUTABLE AS
$$ SELECT left((SELECT string_agg(md5(n::text || '/' || i::text), '' ORDER BY i)
    FROM generate_series(1, (scalars + 31) / 32) i), scalars) $$;
CREATE FUNCTION send_hash(b text, c uuid, t uuid, r uuid) RETURNS bytea LANGUAGE sql IMMUTABLE AS
$$ SELECT sha256(convert_to(jsonb_build_array(b,c,t,r)::text, 'UTF8')) $$;

-- Independent expected effects, written before state/log writes in the same
-- transaction. This oracle cost is charged equally; it is benchmark-only.
CREATE TABLE expected_operations (
 organization_id uuid NOT NULL, ordinal bigserial PRIMARY KEY, operation text NOT NULL,
 channel_id uuid NOT NULL, position bigint NOT NULL, message_id uuid NOT NULL,
 version bigint NOT NULL, kind text NOT NULL, deleted boolean NOT NULL, body text NOT NULL
);
