-- Reserve each id for the lifetime of its owner, including after section deletion.
CREATE TABLE member_section_ids (
    organization_id uuid NOT NULL,
    member_id uuid NOT NULL,
    id uuid NOT NULL,
    PRIMARY KEY (organization_id, member_id, id),
    FOREIGN KEY (organization_id, member_id) REFERENCES users (organization_id, id)
);

CREATE TABLE member_sections (
    organization_id uuid NOT NULL,
    member_id uuid NOT NULL,
    id uuid NOT NULL,
    name text NOT NULL CONSTRAINT member_sections_name_length CHECK (char_length(name) BETWEEN 1 AND 60),
    original_name text NOT NULL,
    position bigint NOT NULL CHECK (position >= 0),
    PRIMARY KEY (organization_id, member_id, id),
    FOREIGN KEY (organization_id, member_id) REFERENCES users (organization_id, id),
    FOREIGN KEY (organization_id, member_id, id) REFERENCES member_section_ids (organization_id, member_id, id)
);
CREATE INDEX member_sections_order ON member_sections (organization_id, member_id, position, id);

CREATE TABLE member_section_placements (
    organization_id uuid NOT NULL,
    member_id uuid NOT NULL,
    channel_id uuid NOT NULL,
    section_id uuid,
    position bigint NOT NULL CHECK (position >= 0),
    PRIMARY KEY (organization_id, member_id, channel_id),
    FOREIGN KEY (organization_id, member_id) REFERENCES users (organization_id, id),
    -- Channel deletion must inspect access before explicitly clearing placements (Q10).
    FOREIGN KEY (organization_id, channel_id) REFERENCES channels (organization_id, id),
    FOREIGN KEY (organization_id, member_id, section_id)
        REFERENCES member_sections (organization_id, member_id, id) ON DELETE CASCADE
);
CREATE INDEX member_section_placements_by_group
    ON member_section_placements (organization_id, member_id, section_id, position, channel_id);
CREATE INDEX member_section_placements_by_channel
    ON member_section_placements (organization_id, channel_id, member_id);

CREATE TABLE member_section_generations (
    organization_id uuid NOT NULL,
    member_id uuid NOT NULL,
    generation bigint NOT NULL DEFAULT 0 CHECK (generation >= 0),
    PRIMARY KEY (organization_id, member_id),
    FOREIGN KEY (organization_id, member_id) REFERENCES users (organization_id, id)
);

CREATE FUNCTION record_member_section_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO public.member_section_ids (organization_id, member_id, id)
        VALUES (NEW.organization_id, NEW.member_id, NEW.id);
        NEW.original_name := NEW.name;
    ELSIF (NEW.organization_id, NEW.member_id, NEW.id, NEW.original_name)
        IS DISTINCT FROM (OLD.organization_id, OLD.member_id, OLD.id, OLD.original_name) THEN
        RAISE EXCEPTION 'section identity and original name are immutable' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER member_sections_identity BEFORE INSERT OR UPDATE ON member_sections
    FOR EACH ROW EXECUTE FUNCTION record_member_section_identity();

-- The regular runtime grants cover all tenant tables. Keep reservations immutable
-- even when those grants are reapplied after restore.
CREATE FUNCTION retain_member_section_id() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'section id reservations are immutable' USING ERRCODE = '23514';
END $$;
CREATE TRIGGER member_section_ids_immutable BEFORE UPDATE OR DELETE ON member_section_ids
    FOR EACH ROW EXECUTE FUNCTION retain_member_section_id();

-- Channel kind is immutable, so a placement only needs checking when its Channel is set.
CREATE FUNCTION reject_dm_section_placement() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM public.channels
        WHERE organization_id = NEW.organization_id AND id = NEW.channel_id AND kind = 'channel'
    ) THEN
        RAISE EXCEPTION 'only ordinary Channels can be placed' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER member_section_placements_no_dm
    AFTER INSERT OR UPDATE OF organization_id, channel_id ON member_section_placements
    FOR EACH ROW EXECUTE FUNCTION reject_dm_section_placement();

ALTER TABLE member_section_ids ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON member_section_ids FOR ALL
    USING (organization_id = fukulow_current_org())
    WITH CHECK (organization_id = fukulow_current_org());
ALTER TABLE member_sections ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON member_sections FOR ALL
    USING (organization_id = fukulow_current_org())
    WITH CHECK (organization_id = fukulow_current_org());
ALTER TABLE member_section_placements ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON member_section_placements FOR ALL
    USING (organization_id = fukulow_current_org())
    WITH CHECK (organization_id = fukulow_current_org());
ALTER TABLE member_section_generations ENABLE ROW LEVEL SECURITY;
CREATE POLICY org_isolation ON member_section_generations FOR ALL
    USING (organization_id = fukulow_current_org())
    WITH CHECK (organization_id = fukulow_current_org());
