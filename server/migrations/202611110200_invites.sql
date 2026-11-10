CREATE TABLE invites (
    organization_id uuid NOT NULL REFERENCES organizations (organization_id),
    id uuid NOT NULL,
    email text NOT NULL CHECK (email = lower(email)),
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
    accepted_at timestamptz,
    PRIMARY KEY (organization_id, id),
    UNIQUE (token_hash)
);

-- Serialize Owner transitions, including direct SQL and deactivation, per Organization.
CREATE FUNCTION protect_last_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- A lock alone leaves old REPEATABLE READ snapshots valid and can lose both Owners.
    -- A non-key write forces those snapshots to fail serialization before counting Owners.
    UPDATE organizations SET name = name WHERE organization_id = NEW.organization_id;
    IF TG_OP = 'UPDATE' AND OLD.role = 'owner' AND OLD.deactivated_at IS NULL
       AND (NEW.role <> 'owner' OR NEW.deactivated_at IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM users WHERE organization_id = OLD.organization_id
                       AND id <> OLD.id AND role = 'owner' AND deactivated_at IS NULL) THEN
        RAISE EXCEPTION 'last_owner' USING ERRCODE = '23514', CONSTRAINT = 'users_last_owner';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER protect_last_owner BEFORE INSERT OR UPDATE OF role, deactivated_at ON users
FOR EACH ROW EXECUTE FUNCTION protect_last_owner();
