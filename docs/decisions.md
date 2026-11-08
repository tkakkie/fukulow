# Decisions

- Rust + PostgreSQL + WebSocket; Svelte SPA embedded in the binary. Reason: performance, one-image delivery.
- Reverse proxy is optional: app speaks plain HTTP; Caddy (default) or nginx via compose profile. Reason: Caddy gave trouble in ribbitto and may limit performance.
- OpenAPI generated from Rust, committed, diff-checked in CI. Reason: future native clients (Kotlin).
- `organization_id` on every table from day one. Reason: multi-organization later without retrofit.
- Minimal docs. Reason: AI credit cost.
- Public repo. Reason: free CI minutes.
- Authentication is scoped by `organization_id` (returned by setup) plus normalized email; users are organization memberships. The organization row is its own tenant root. Only the global, table-locked setup check is unscoped, because it must refuse setup if any organization exists.
- Web cookies and native bearer auth share an opaque, random 256-bit session credential, with an organization prefix and only its SHA-256 hash stored. Sessions expire after 30 days and sign-out revokes both forms. Cookies are HttpOnly, SameSite=Strict, Secure by default; `FUKULOW_COOKIE_SECURE=false` is for local HTTP only. Password hashing/verification runs on at most four blocking workers with Argon2id to bound memory use.
- Runtime migrations run before listening; PostgreSQL 18 persists under `/var/lib/postgresql`. `make api` exports the Rust contract without connecting to the database and generates TypeScript declarations with pinned `openapi-typescript` in an isolated npm tool environment (its TypeScript 5 peer is incompatible with the SPA’s TypeScript 6 dependency). CI diff-checks both artifacts.
