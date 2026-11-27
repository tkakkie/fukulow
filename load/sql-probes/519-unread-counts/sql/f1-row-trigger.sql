CREATE OR REPLACE FUNCTION message_counts_inserted() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    nil CONSTANT uuid := '00000000-0000-0000-0000-000000000000';
    scope_key uuid := COALESCE(NEW.topic_id, nil);
    member_key uuid;
    append_delta bigint := CASE WHEN NEW.sender = nil THEN 2 ELSE 1 END;
BEGIN
    -- The total sorts first. A nil sender shares that key and contributes twice,
    -- as in the grouped statement trigger.
    FOREACH member_key IN ARRAY ARRAY[nil, NEW.sender]
    LOOP
        UPDATE message_append_counts k SET appended = k.appended + append_delta
        WHERE (k.organization_id, k.channel_id, k.scope_id, k.member_id)
            = (NEW.organization_id, NEW.channel_id, scope_key, member_key);

        IF NOT FOUND THEN
            INSERT INTO message_append_counts AS k (organization_id, channel_id, scope_id, member_id, appended)
            VALUES (NEW.organization_id, NEW.channel_id, scope_key, member_key, append_delta)
            ON CONFLICT (organization_id, channel_id, scope_id, member_id) DO UPDATE
                SET appended = k.appended + EXCLUDED.appended;
        END IF;

        EXIT WHEN member_key = NEW.sender;
    END LOOP;

    IF NEW.deleted THEN
        INSERT INTO message_count_corrections
        VALUES (NEW.organization_id, NEW.channel_id, scope_key, NEW.seq, NEW.id, NEW.sender, -1);
    END IF;
    RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS messages_counts_inserted ON messages;
CREATE TRIGGER messages_counts_inserted AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION message_counts_inserted();
