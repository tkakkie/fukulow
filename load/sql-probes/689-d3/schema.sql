-- Synthetic subset of the B1 schema. A DM is a Channel with NULL visibility.
CREATE FUNCTION public.fukulow_current_org() RETURNS uuid LANGUAGE sql STABLE
RETURN nullif(current_setting('fukulow.organization_id', true), '')::uuid;

CREATE COLLATION public.search_unicode (provider = builtin, locale = 'PG_UNICODE_FAST');
CREATE FUNCTION public.search_normalize(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT
RETURN normalize(casefold(normalize($1, NFC) COLLATE public.search_unicode), NFC) COLLATE "C";

CREATE TABLE public.users (
    organization_id uuid NOT NULL, id uuid NOT NULL, role text NOT NULL,
    deactivated_at timestamptz, membership_revision bigint NOT NULL DEFAULT 1,
    PRIMARY KEY (organization_id, id)
);
CREATE TABLE public.channels (
    organization_id uuid NOT NULL, id uuid NOT NULL, visibility text,
    PRIMARY KEY (organization_id, id)
);
CREATE TABLE public.channel_members (
    organization_id uuid NOT NULL, channel_id uuid NOT NULL, member_id uuid NOT NULL,
    membership_revision bigint NOT NULL DEFAULT 1, grant_id uuid NOT NULL DEFAULT gen_random_uuid(),
    PRIMARY KEY (organization_id, channel_id, member_id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES public.channels,
    FOREIGN KEY (organization_id, member_id) REFERENCES public.users
);
CREATE TABLE public.messages (
    organization_id uuid NOT NULL, id bigint NOT NULL, channel_id uuid NOT NULL,
    created_at timestamptz NOT NULL, body text NOT NULL,
    normalized_body text COLLATE "C" GENERATED ALWAYS AS (public.search_normalize(body)) STORED,
    PRIMARY KEY (organization_id, id),
    FOREIGN KEY (organization_id, channel_id) REFERENCES public.channels
);
CREATE TABLE public.search_terms (
    organization_id uuid NOT NULL, message_id bigint NOT NULL,
    scope_term text COLLATE "C" NOT NULL,
    FOREIGN KEY (organization_id, message_id) REFERENCES public.messages
);
CREATE INDEX search_terms_message ON public.search_terms (organization_id, message_id);

DO $$
DECLARE target regclass;
BEGIN
    FOREACH target IN ARRAY ARRAY['public.users', 'public.channels', 'public.channel_members',
        'public.messages', 'public.search_terms']::regclass[]
    LOOP
        EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', target);
        EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', target);
        EXECUTE format('CREATE POLICY org_isolation ON %s USING
            (organization_id = public.fukulow_current_org()) WITH CHECK
            (organization_id = public.fukulow_current_org())', target);
    END LOOP;
END $$;

CREATE FUNCTION public.maintain_search_terms() RETURNS trigger LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        DELETE FROM public.search_terms
        WHERE organization_id = OLD.organization_id AND message_id = OLD.id;
        IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    END IF;
    INSERT INTO public.search_terms (organization_id, message_id, scope_term)
    SELECT DISTINCT NEW.organization_id, NEW.id,
        NEW.channel_id::text || ':' || substr(NEW.normalized_body, pos, width) COLLATE "C"
    FROM generate_series(1, 3) AS widths(width)
    CROSS JOIN LATERAL generate_series(1, length(NEW.normalized_body) - width + 1) AS positions(pos);
    RETURN NULL;
END $$;

-- Remove terms before the referenced Message disappears. Index the generated
-- normalized_body after a send or update, in the same transaction.
CREATE TRIGGER search_terms_remove BEFORE DELETE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.maintain_search_terms();
CREATE TRIGGER search_terms_store AFTER INSERT OR UPDATE OF body, channel_id ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.maintain_search_terms();

GRANT SELECT ON public.users, public.channels, public.channel_members, public.messages,
    public.search_terms TO fukulow_probe;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO fukulow_probe_writer;
GRANT SELECT, INSERT, DELETE ON public.search_terms TO fukulow_probe_writer;
