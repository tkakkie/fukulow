-- SQLx runs this entire migration in one transaction; never merge people by email.
DO $$
DECLARE duplicates text;
BEGIN
    SELECT string_agg(email, ', ' ORDER BY email) INTO duplicates
    FROM (SELECT lower(email) AS email FROM users GROUP BY lower(email)
          HAVING count(DISTINCT organization_id) > 1) duplicate_emails;
    IF duplicates IS NOT NULL THEN
        RAISE EXCEPTION 'Account migration refused duplicate emails: %', duplicates;
    END IF;
END $$;

CREATE TABLE accounts (
    id uuid PRIMARY KEY,
    email text NOT NULL UNIQUE CHECK (email = lower(email)),
    password_hash text NOT NULL
);
INSERT INTO accounts (id, email, password_hash) SELECT gen_random_uuid(), email, password_hash FROM users;
ALTER TABLE users ADD COLUMN account_id uuid REFERENCES accounts (id);
UPDATE users SET account_id = a.id FROM accounts a WHERE users.email = a.email;
ALTER TABLE users ALTER COLUMN account_id SET NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_organization_account_unique UNIQUE (organization_id, account_id);
ALTER TABLE users ADD COLUMN deactivated_at timestamptz;
ALTER TABLE users ADD COLUMN membership_revision bigint NOT NULL DEFAULT 0 CHECK (membership_revision >= 0);
ALTER TABLE users DROP COLUMN email;
ALTER TABLE users DROP COLUMN password_hash;

-- Revocation generation survives reactivation, including updates outside the application.
CREATE FUNCTION protect_member_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Member rows must never be deleted';
    END IF;
    IF NEW.organization_id <> OLD.organization_id OR NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id THEN
        RAISE EXCEPTION 'Member identity must never be changed';
    END IF;
    IF OLD.deactivated_at IS NULL AND NEW.deactivated_at IS NOT NULL THEN
        NEW.membership_revision := OLD.membership_revision + 1;
    ELSIF NEW.membership_revision <> OLD.membership_revision THEN
        RAISE EXCEPTION 'Membership revision changes only on deactivation';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER protect_member_identity BEFORE UPDATE OR DELETE ON users
FOR EACH ROW EXECUTE FUNCTION protect_member_identity();

-- Old private grants stay historical: their generation can never authorize reactivation.
ALTER TABLE channel_members ADD COLUMN membership_revision bigint NOT NULL DEFAULT 0;

-- No old credential is accepted after this migration.
DROP TABLE sessions;
CREATE TABLE account_sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    account_id uuid NOT NULL REFERENCES accounts (id),
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days')
);
CREATE INDEX account_sessions_expiry ON account_sessions (expires_at, token_hash);
