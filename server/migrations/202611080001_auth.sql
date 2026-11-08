-- The organization is its own tenant root; all other keys include that tenant.
CREATE TABLE organizations (
    organization_id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200)
);

CREATE TABLE users (
    organization_id uuid NOT NULL REFERENCES organizations (organization_id),
    id uuid NOT NULL,
    email text NOT NULL CHECK (email = lower(email)),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'guest')),
    PRIMARY KEY (organization_id, id),
    UNIQUE (organization_id, email)
);

CREATE TABLE sessions (
    organization_id uuid NOT NULL,
    token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
    user_id uuid NOT NULL,
    expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
    PRIMARY KEY (organization_id, token_hash),
    FOREIGN KEY (organization_id, user_id) REFERENCES users (organization_id, id)
);
CREATE INDEX sessions_expiry ON sessions (expires_at);
