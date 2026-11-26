-- Run as the owner with the app stopped. SQLx wraps the complete swap in one transaction.
-- phase: lock
SET LOCAL row_security = off;
LOCK TABLE public.messages, public.channel_log IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.channel_message_sequences IN SHARE MODE;

-- phase: validate
DO $$
BEGIN
    IF EXISTS (
        SELECT FROM public.channel_log l JOIN public.messages m
          ON (m.organization_id, m.channel_id, m.seq) = (l.organization_id, l.channel_id, l.event_seq)
        WHERE l.kind <> 'create'
    ) THEN
        RAISE EXCEPTION 'Message creation overlaps a mutation position';
    END IF;

    IF EXISTS (
        SELECT FROM public.messages m
        FULL JOIN (SELECT * FROM public.channel_log WHERE kind = 'create') l
          ON (m.organization_id, m.channel_id, m.seq) = (l.organization_id, l.channel_id, l.event_seq)
        WHERE (m.id, m.sender, m.client_message_id) IS DISTINCT FROM
              (l.message_id, l.sender, l.client_message_id)
    ) THEN
        RAISE EXCEPTION 'Create log and Messages are not in bijection';
    END IF;

    -- The bijection substitutes exactly the same creation positions. The old
    -- PK and positive-position check make count = max = W a proof of 1..W.
    IF EXISTS (
        SELECT FROM (
            SELECT organization_id, channel_id, count(*) AS positions, max(event_seq) AS tail
            FROM public.channel_log GROUP BY organization_id, channel_id
        ) l FULL JOIN public.channel_message_sequences s USING (organization_id, channel_id)
        WHERE l.positions IS DISTINCT FROM s.seq OR l.tail IS DISTINCT FROM s.seq
    ) THEN
        RAISE EXCEPTION 'Channel positions do not cover the committed watermark';
    END IF;
END $$;

-- phase: copy
CREATE TABLE public.channel_log_mutations (
    organization_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    event_seq bigint NOT NULL CHECK (event_seq > 0),
    kind text NOT NULL,
    message_id uuid NOT NULL,
    sender uuid NOT NULL,
    operation_id uuid NOT NULL,
    source_topic_id uuid,
    destination_topic_id uuid NOT NULL,
    CONSTRAINT channel_log_event_shape CHECK (
        kind = 'move' AND source_topic_id IS DISTINCT FROM destination_topic_id
    )
);

INSERT INTO public.channel_log_mutations (
    organization_id, channel_id, event_seq, kind, message_id, sender, operation_id, source_topic_id, destination_topic_id
)
SELECT organization_id, channel_id, event_seq, kind, message_id, sender, operation_id, source_topic_id, destination_topic_id
FROM public.channel_log WHERE kind <> 'create';

-- phase: index_and_constraints
ALTER TABLE public.channel_log_mutations
    ADD PRIMARY KEY (organization_id, channel_id, event_seq),
    ADD CONSTRAINT channel_log_channel_fkey FOREIGN KEY (organization_id, channel_id)
        REFERENCES public.channels (organization_id, id),
    ADD CONSTRAINT channel_log_sender_fkey FOREIGN KEY (organization_id, sender)
        REFERENCES public.users (organization_id, id);

ALTER TABLE public.channel_log_mutations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_read ON public.channel_log_mutations FOR SELECT
    USING (organization_id = fukulow_current_org());
CREATE POLICY org_append ON public.channel_log_mutations FOR INSERT
    WITH CHECK (organization_id = fukulow_current_org());

-- phase: swap_and_protect
DROP TABLE public.channel_log;
ALTER TABLE public.channel_log_mutations RENAME TO channel_log;
ALTER TABLE public.channel_log RENAME CONSTRAINT channel_log_mutations_pkey TO channel_log_pkey;

-- A retained Message is the only source of its Create position.
CREATE FUNCTION public.fukulow_message_creation_fixed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.organization_id, NEW.channel_id, NEW.seq, NEW.id, NEW.sender, NEW.client_message_id)
        IS DISTINCT FROM (OLD.organization_id, OLD.channel_id, OLD.seq, OLD.id, OLD.sender, OLD.client_message_id)
    THEN
        RAISE EXCEPTION 'Message creation identity is immutable' USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER messages_creation_fixed
    BEFORE UPDATE OF organization_id, channel_id, seq, id, sender, client_message_id ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.fukulow_message_creation_fixed();

DROP TRIGGER messages_counts_deleted ON public.messages;
DROP FUNCTION public.message_counts_deleted();

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'fukulow_app') THEN
        REVOKE ALL ON public.channel_log, public.messages FROM fukulow_app;
        GRANT SELECT, INSERT ON public.channel_log, public.messages TO fukulow_app;
        GRANT UPDATE (body, topic_id, version, deleted) ON public.messages TO fukulow_app;
    END IF;
END $$;
