# Decisions

- Rust + PostgreSQL + WebSocket; Svelte SPA embedded in the binary. Reason: performance, one-image delivery.
- Reverse proxy is optional: app speaks plain HTTP; Caddy (default) or nginx via compose profile. Reason: Caddy gave trouble in ribbitto and may limit performance.
- OpenAPI generated from Rust, committed, diff-checked in CI. Reason: future native clients (Kotlin).
- `organization_id` on every table from day one. Reason: multi-organization later without retrofit.
- Minimal docs. Reason: AI credit cost.
- Public repo. Reason: free CI minutes.
