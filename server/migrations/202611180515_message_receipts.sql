-- #515 slice 2. The original-send receipt (S5) is a SHA-256 digest of the send
-- intent, fixed at creation, so a retry never compares against mutable current
-- state. No plaintext is kept; the digest lives as long as the Message
-- (maintainer, 2026-11-17). This is the only encoder: inserts, the backfill and
-- retry checks all call it. Fields are tagged and length-prefixed, so no two
-- intents share an encoding. topic_key is the normalized Topic name_key of a
-- non-Reply send (NULL for the main timeline and for every Reply).
CREATE FUNCTION fukulow_send_digest(channel_id uuid, body text, topic_key text, reply_to uuid)
RETURNS bytea LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
    SELECT pg_catalog.sha256(
        pg_catalog.convert_to('fukulow.send.v1', 'UTF8')
        || pg_catalog.uuid_send(channel_id)
        || CASE WHEN reply_to IS NULL THEN '\x00'::bytea ELSE '\x01'::bytea || pg_catalog.uuid_send(reply_to) END
        || CASE WHEN topic_key IS NULL THEN '\x00'::bytea
                ELSE '\x01'::bytea || pg_catalog.int4send(pg_catalog.octet_length(topic_key)) || pg_catalog.convert_to(topic_key, 'UTF8') END
        || pg_catalog.int4send(pg_catalog.octet_length(body)) || pg_catalog.convert_to(body, 'UTF8'))
$$;

-- version: the last event position affecting the Message (its creation
-- position until a mutation). expected_version preconditions compare it.
ALTER TABLE messages ADD COLUMN version bigint, ADD COLUMN send_digest bytea;
UPDATE messages m SET version = m.seq, send_digest = fukulow_send_digest(
    m.channel_id, m.body,
    CASE WHEN m.reply_to_id IS NULL THEN
        (SELECT t.name_key FROM topics t WHERE t.organization_id = m.organization_id AND t.channel_id = m.channel_id AND t.id = m.topic_id)
    END,
    m.reply_to_id);
ALTER TABLE messages
    ALTER COLUMN version SET NOT NULL,
    ALTER COLUMN send_digest SET NOT NULL,
    ADD CONSTRAINT messages_version_after_creation CHECK (version >= seq),
    ADD CONSTRAINT messages_send_digest_sha256 CHECK (octet_length(send_digest) = 32);

-- Every insert, including load fixtures and tests that insert directly, gets
-- its creation version and receipt from the row itself; callers cannot supply
-- either. The Topic row is read in the inserting transaction.
CREATE FUNCTION fukulow_message_created() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.version := NEW.seq;
    NEW.send_digest := public.fukulow_send_digest(
        NEW.channel_id, NEW.body,
        CASE WHEN NEW.reply_to_id IS NULL THEN
            (SELECT t.name_key FROM public.topics t
             WHERE t.organization_id = NEW.organization_id AND t.channel_id = NEW.channel_id AND t.id = NEW.topic_id)
        END,
        NEW.reply_to_id);
    RETURN NEW;
END $$;
CREATE TRIGGER messages_created BEFORE INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION fukulow_message_created();

-- The receipt never follows current state, and versions never go backwards.
CREATE FUNCTION fukulow_message_receipt_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.send_digest IS DISTINCT FROM OLD.send_digest THEN
        RAISE EXCEPTION 'send receipt is immutable' USING ERRCODE = 'P0001';
    END IF;
    IF NEW.version < OLD.version THEN
        RAISE EXCEPTION 'Message version cannot decrease' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER messages_receipt_fixed BEFORE UPDATE OF send_digest, version ON messages
    FOR EACH ROW EXECUTE FUNCTION fukulow_message_receipt_fixed();

-- Edit/Move/Delete operation receipts (#287/#141 write them; no endpoint yet).
-- Kept 7 days (maintainer, #515): an older row is ignored and may be replaced,
-- and the mutation's expected_version stops an expired retry from re-executing.
-- No FK to messages: deleting state never removes a receipt.
CREATE TABLE operation_receipts (
    organization_id uuid NOT NULL,
    actor uuid NOT NULL,
    operation_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('edit', 'move', 'delete')),
    channel_id uuid NOT NULL,
    target_id uuid NOT NULL,
    intent_digest bytea NOT NULL CHECK (octet_length(intent_digest) = 32),
    outcome_version bigint NOT NULL CHECK (outcome_version > 0),
    outcome_deleted boolean NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (organization_id, actor, operation_id),
    FOREIGN KEY (organization_id, actor) REFERENCES users (organization_id, id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id)
);
ALTER TABLE operation_receipts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON operation_receipts FOR ALL
    USING (organization_id = fukulow_current_org())
    WITH CHECK (organization_id = fukulow_current_org());
