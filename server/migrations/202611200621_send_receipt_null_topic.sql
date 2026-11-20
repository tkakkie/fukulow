-- #621: Only prepare the Topic lookup for sends with explicit Topic intent.
CREATE OR REPLACE FUNCTION public.fukulow_message_created() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    topic_key text;
BEGIN
    NEW.version := NEW.seq;
    IF NEW.topic_id IS NOT NULL AND NEW.reply_to_id IS NULL THEN
        topic_key := (SELECT t.name_key FROM public.topics t
                      WHERE t.organization_id = NEW.organization_id AND t.channel_id = NEW.channel_id AND t.id = NEW.topic_id);
    END IF;
    NEW.send_digest := public.fukulow_send_digest(
        NEW.channel_id, NEW.body, topic_key, NEW.reply_to_id);
    RETURN NEW;
END $$;
