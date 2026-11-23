\set ON_ERROR_STOP on
-- A3: no new column or index on messages. Appended counts live on counter rows that send already updates,
-- plus one small row per (scope, sender). Ordinals at a read position are written when it is marked or initialized.
ALTER TABLE channel_message_sequences ADD COLUMN main_ordinal bigint NOT NULL DEFAULT 0;
UPDATE channel_message_sequences s SET main_ordinal = (SELECT count(*) FROM messages m WHERE m.organization_id = s.organization_id AND m.channel_id = s.channel_id AND m.topic_id IS NULL);
ALTER TABLE topics ADD COLUMN scope_ordinal bigint NOT NULL DEFAULT 0;
UPDATE topics t SET scope_ordinal = (SELECT count(*) FROM messages m WHERE m.organization_id = t.organization_id AND m.topic_id = t.id);
CREATE TABLE scope_sender_counts (
  organization_id uuid NOT NULL, channel_id uuid NOT NULL, scope_id uuid NOT NULL, member_id uuid NOT NULL,
  sent_ordinal bigint NOT NULL, PRIMARY KEY (organization_id, channel_id, member_id, scope_id)) WITH (fillfactor = 70);
ALTER TABLE scope_sender_counts ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scope_sender_counts USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
GRANT SELECT ON scope_sender_counts TO fukulow_app;
INSERT INTO scope_sender_counts SELECT organization_id, channel_id, coalesce(topic_id,'00000000-0000-0000-0000-000000000000'), sender, count(*) FROM messages GROUP BY 1,2,3,4;
ALTER TABLE channel_read_positions ADD COLUMN read_ordinal bigint NOT NULL DEFAULT 0, ADD COLUMN read_own_ordinal bigint NOT NULL DEFAULT 0;
ALTER TABLE topic_read_positions ADD COLUMN read_ordinal bigint NOT NULL DEFAULT 0, ADD COLUMN read_own_ordinal bigint NOT NULL DEFAULT 0;
CREATE TABLE scope_count_corrections (
  organization_id uuid NOT NULL, channel_id uuid NOT NULL, scope_id uuid NOT NULL, seq bigint NOT NULL,
  message_id uuid NOT NULL, sender uuid NOT NULL, delta smallint NOT NULL,
  PRIMARY KEY (organization_id, channel_id, scope_id, seq, message_id));
ALTER TABLE scope_count_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON scope_count_corrections USING (organization_id = fukulow_current_org()) WITH CHECK (organization_id = fukulow_current_org());
GRANT SELECT ON scope_count_corrections TO fukulow_app;
INSERT INTO scope_count_corrections
SELECT organization_id, channel_id, coalesce(topic_id,'00000000-0000-0000-0000-000000000000'), seq, id, sender, -1 FROM messages WHERE deleted;
DELETE FROM message_mentions mm USING messages m WHERE m.organization_id = mm.organization_id AND m.id = mm.message_id AND (m.deleted OR m.sender = mm.member_id);
ALTER TABLE message_mentions ADD COLUMN seq bigint, ADD COLUMN topic_id uuid;
UPDATE message_mentions mm SET seq = m.seq, topic_id = m.topic_id FROM messages m WHERE m.organization_id = mm.organization_id AND m.id = mm.message_id;
CREATE INDEX message_mentions_member_scope_seq ON message_mentions (organization_id, member_id, channel_id, topic_id, seq);
DROP INDEX message_mentions_member_channel_message;
