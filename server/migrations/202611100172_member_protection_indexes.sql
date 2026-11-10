CREATE INDEX users_account_id ON users (account_id);
CREATE INDEX account_sessions_account_id ON account_sessions (account_id);

CREATE FUNCTION forbid_member_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Member rows must never be truncated';
END $$;
CREATE TRIGGER protect_member_truncate BEFORE TRUNCATE ON users
FOR EACH STATEMENT EXECUTE FUNCTION forbid_member_truncate();
