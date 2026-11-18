ALTER TABLE messages ADD COLUMN deleted boolean NOT NULL DEFAULT false;

-- Preserve coverage for the live main Unread range and give Topic repair
-- bounded first/last live Message lookups, even with long tombstone prefixes.
DROP INDEX messages_main_unread_covering;
CREATE INDEX messages_main_unread_covering
    ON messages (organization_id, channel_id, seq) INCLUDE (sender, id)
    WHERE topic_id IS NULL AND NOT deleted;
CREATE INDEX messages_live_topic_seq
    ON messages (organization_id, channel_id, topic_id, seq) INCLUDE (sender, id)
    WHERE topic_id IS NOT NULL AND NOT deleted;

ALTER TABLE topics
    ALTER COLUMN first_seq DROP NOT NULL,
    ALTER COLUMN last_seq DROP NOT NULL,
    DROP CONSTRAINT topics_message_count_check,
    ADD CONSTRAINT topics_live_summary CHECK (
        (message_count = 0 AND first_seq IS NULL AND last_seq IS NULL)
        OR (message_count > 0 AND first_seq IS NOT NULL AND last_seq IS NOT NULL)
    );

-- Existing Create identity stays unchanged. Move records the actor in sender
-- and its own operation identity, independently of the root's send identity.
ALTER TABLE channel_log
    ALTER COLUMN client_message_id DROP NOT NULL,
    ADD COLUMN operation_id uuid,
    ADD COLUMN source_topic_id uuid,
    ADD COLUMN destination_topic_id uuid,
    DROP CONSTRAINT channel_log_kind_check,
    ADD CONSTRAINT channel_log_event_shape CHECK (
        (kind = 'create' AND client_message_id IS NOT NULL AND operation_id IS NULL
            AND source_topic_id IS NULL AND destination_topic_id IS NULL)
        OR (kind = 'move' AND client_message_id IS NULL AND operation_id IS NOT NULL
            AND destination_topic_id IS NOT NULL AND source_topic_id IS DISTINCT FROM destination_topic_id)
    );

CREATE INDEX operation_receipts_expiry
    ON operation_receipts (organization_id, created_at, actor, operation_id);

-- Chain versions are independent of the history page's size/continuation.
CREATE INDEX messages_reply_chain_version
    ON messages (organization_id, channel_id, reply_root_id, version DESC)
    WHERE reply_root_id IS NOT NULL;

-- The original operation's event position is absent on a canonical no-op.
ALTER TABLE operation_receipts ADD COLUMN outcome_event_seq bigint
    CHECK (outcome_event_seq = outcome_version);

-- Check that no direct child of the selected chain was filed under another root.
CREATE INDEX messages_reply_parent
    ON messages (organization_id, channel_id, reply_to_id) INCLUDE (reply_root_id)
    WHERE reply_to_id IS NOT NULL;

-- Oversized chains can replay a prior receipt; recheck whole-chain ownership
-- with two indexed sender bounds instead of walking an unbounded Reply range.
CREATE INDEX messages_reply_chain_sender
    ON messages (organization_id, channel_id, reply_root_id, sender)
    WHERE reply_root_id IS NOT NULL;
