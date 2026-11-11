# Workflow (operating procedure for AIs)

Follow this without waiting for a human prompt. Rules: `AGENTS.md`. Rationale: `docs/decisions.md`.
Run commands for GitHub as your own identity: `$FUKULOW_RUN_AS <claude|codex|antigravity> <command>` (local helper, configured outside the repo) (`< /dev/null`), e.g. `... gh pr list`, `... git push -q origin HEAD:<branch>`.
Never push to `main`. Never merge unless the maintainer explicitly says so.

Cloud session (no `$FUKULOW_RUN_AS`, Codex or Antigravity): a Claude Code cloud session does Issues, PRs, labels and reviews through its GitHub integration. Maintainer-only review (no second AI) is allowed only for (a) docs-only changes, or (b) changes limited to a CI script that checks doc length limits and its tests. Excluded: product code, auth, permissions, tenant scoping, real-time delivery, migrations, and anything that weakens an existing CI check. The Issue must state this scope and the maintainer must approve it; all other changes keep section 5. It never replaces CI: required checks `web`, `server`, `docker` must be green on the head, as the `main` ruleset requires.

## 1. Sweep (run at every wake-up, notification, user message, or finished AI run)
1. `gh pr list --state open --limit 200 --json number,title,labels,headRefOid,mergeable,statusCheckRollup` and `gh issue list --state open --limit 200 --json number,title,labels,milestone`; if 200 come back, split with `--search 'created:<date'` until the list is exhausted. For cleanup also list recent merges: `gh pr list --state merged --limit 30 --json number,headRefName,labels,mergedAt`.
2. For each item, find its row in section 2 and do the "Next action" if an AI can do it. Then re-list; repeat until nothing AI-doable is left.
3. Fix labels: at most one `status:*` label per item; an open item with none gets the one that matches its state; green + reviews done never stays unlabelled.
4. Check for stalls (section 7): an AI run that ended without updating label/comment, stale CI, `blocked` whose blocker is merged.
5. Waiting is not the same as human-pending. Items waiting for an async result (CI, Copilot, a background AI run) keep their current label; never move them to `status:human-review` or `status:needs-decision` to park them. Check async state with one non-blocking query per item per sweep (`gh pr checks <n>` without `--watch`, `gh pr view --json reviews`, the worker `-o` file and `pgrep`); never block the sweep on it.
6. When no AI-doable item is left, end this sweep iteration even if items still wait for async results (CI, Copilot, background AI). Do not re-poll them in a loop: each waiting item is checked at most once per iteration. Resume on a completion notification, the next sweep (wake-up, user message), or a stall check (section 7), whichever comes first. Report the human-pending list (`status:human-review` / `status:needs-decision`, question in the last comment) and name what is still waiting.

## 2. State -> next action
| Item, label | Who acts | Next action | Step ends when |
|---|---|---|---|
| Issue, none | author AI | Add "Done when", milestone; feature: "How I read the spec" (3-5 lines, spec terms). Decide the review path (section 3) | label set: `status:ai-review` or `status:human-review`, or `status:ready` on the AI-decided path |
| Issue, `status:ai-review`, not yet reviewed | an AI that did not write it | Review (section 5), comment | verdict commented; no blocking findings -> `status:human-review` |
| Issue, `status:ai-review`, round 1 had blocking findings | author AI | Fix the Issue, comment how each finding was addressed, ask for round 2 (a reviewer checks only the delta) | round 2 verdict: clean -> `status:human-review`; blocking left -> `status:needs-decision` |
| Issue, `status:human-review` | maintainer | none for AI. Do other work | maintainer comments "OK" |
| Issue, `status:human-review` and a maintainer "OK" comment | any AI | Set `status:ready` (replaces `status:human-review`). Not for Issues already `status:ready`/`status:working` | label is `status:ready` |
| Issue, `status:ready`, no `blocked` | implementer by area (section 4) | Set `status:working`, branch, worktree, implement, open draft PR | PR open, Issue linked (`Closes #n`); Issue stays `status:working` |
| Issue, `status:ready` and `blocked` | none | `blocked` wins: do not start until every blocker named in the Issue is satisfied (a PR merged; with several blockers, all of them). The row "blocked, blocker resolved" below decides when `blocked` goes | `blocked` removed |
| Issue, `status:working` | implementer | Its PR row governs. No PR and no activity: section 7 (stall) | PR merged, Issue closed |
| PR draft/open, `status:working` | implementer | Run Commands from `AGENTS.md`; push; check CI with `gh pr checks <n>` (non-blocking; see section 1 step 5) | CI green on the head and PR marked ready -> `status:ai-review` |
| PR, `status:ai-review`, CI pending or missing on the head | sweeper | `gh pr checks <n>` (non-blocking), then do other work; missing: section 7 | CI finished on the head |
| PR, `status:ai-review`, CI red | implementer (or sweeper) | Read the failing job tail (`gh run view <id> --log-failed`); fix; transient failure: section 7 | CI green on the head |
| PR, `status:ai-review`, CI green, review not done | sweeper | Launch the required AI review (section 5). Copilot due and not yet requested: request once | review verdict commented |
| PR, `status:ai-review`, blocking findings | implementer | Set `status:working`, fix, push, CI, comment how each was addressed, back to `status:ai-review` for round 2 | blocking findings resolved |
| PR, `status:ai-review`, CI green on the current head, `mergeable` known and MERGEABLE, required review/fix cycle done, Copilot finished if requested | sweeper | Set `status:human-review` (never while conflicting or `mergeable` unknown) | label set |
| PR, `status:human-review` | maintainer | Nothing for AI unless the maintainer asks for changes -> `status:working` | maintainer merges or comments |
| Issue/PR, `status:needs-decision` | maintainer | none for AI; keep working on other items | maintainer answers; AI then removes the label and continues |
| Issue/PR, `blocked`, a blocker PR merged (by anyone) | sweeper | Remove `blocked` only when every blocker is satisfied; otherwise leave it and comment what remains. Set the next status, comment | label removed, or remaining blockers named |
| Issue/PR, `blocked`, a blocker PR closed unmerged | sweeper | The dependency is not satisfied: re-evaluate (is the work still needed, is there a replacement PR). Decidable by an AI from the Issue text: update the blocker reference and comment. Otherwise `status:needs-decision` with what must be decided in the last comment | blocker updated, or decision asked |
| Open PR, `mergeable` is CONFLICTING or still UNKNOWN (any status label) | implementer | Takes precedence over every row below that moves it toward `status:human-review`. Resolve first (section 6), get CI on the new head, and re-check whether the conflict resolution touched code the existing reviews covered (re-verify only that delta). UNKNOWN: re-query until known; never assume it is mergeable | `mergeable` is MERGEABLE and CI is green on the new head |
| Dependency update PR | any AI | Section 8 | `status:human-review` |
| PR merged (see recent merges in section 1) | sweeper | Verify Issue closed; remove status labels; unblock dependents; delete worktree/branch | nothing left open for it |

## 3. Issue review path
- Maintainer approval is always needed for: any new feature or behaviour change (even if described in `docs/spec.md`); auth, permissions, real-time, migrations; API or schema contract changes;
  new dependencies or languages; cost, deploy, secrets. Order: AI review (`status:ai-review`) -> `status:human-review` -> "OK" -> `status:ready`.
- AI review of an Issue is required for `risk:needs-review` and large Issues; for small ones the author may skip it: go straight to `status:human-review` and record the decision and reason in the Issue.
- An AI decides alone only when none of the maintainer-required categories above applies: bug fixes with a clear repro, refactors without behaviour change, tests, CI, docs, patch updates. Then it sets `status:ready` itself; an auth/permissions bug fix or permission tests still go to the maintainer.
- Max 2 review rounds; unresolved blocking findings -> `status:needs-decision` with the question.

## 4. Roles, models, effort
- Codex: Rust server, DB, auth/permissions, real-time, concurrency, load tests. Claude: design, OpenAPI, docs, review. Antigravity: Svelte (screens, state modules), browser checks, E2E.
- Codex implements with `gpt-6.1-sol`, effort `medium`; `high` when any H holds (judge from the whole Issue and the files actually touched; size alone never qualifies):
  H1 auth, permissions, Organization separation, sessions. H2 DB integrity, migrations, transactions, locks. H3 real-time reconnect, event order, dedup, delivery.
  H4 a security, correctness or CI verification gate is added, removed or loosened. H5 behaviour-preserving conversion without an old/new comparison test.
  H6 concurrent paths sharing state or caches, or whether a background job runs, retries or stops. The PR body lists the H numbers applied (or "none").
- Effort is fixed at launch. If an H condition first appears mid-work: the implementer stops and reports; the orchestrator restarts at `high`.
- Codex reviews and checks use `gpt-6-astra`: `high` for round 1 of `risk:needs-review` or gate changes, `medium` for round 2 and delta checks.
- Astra implements only after two substantive sol attempts at `high` both failed the Issue's acceptance criteria (one failing test or CI run is not an attempt); record why in the Issue. Same independent-review rules apply.
- Antigravity: `agy` (`/usr/local/argon-agy/agy`) with the Argon model (Gemini 4 Argon; list with `agy models`); effort is the `--model` suffix `gemini-4-argon-low|medium|high`, fixed at launch. `<agy-home>` is the maintainer-provisioned directory that holds the Antigravity login, shared by all worktrees (an empty `HOME` triggers a login prompt):
  low = small copy, limit or type fixes; medium = new screens or state modules, vitest additions, conflict and CI fixes, browser checks; high = browser-side real-time, auth-screen session handling, new E2E suites, multi-screen state design.
  Size alone does not raise effort. If harder than expected: stop, report, restart higher.
- Claude: Sonnet by default; Opus only for round 1 of high-risk review or heavy implementation.
- Launch every AI under its own identity via `$FUKULOW_RUN_AS <name> <cli ...>` (its own GitHub token). Put the model and effort in the signature line.
- Orchestrator: start each worker with the Bash tool and `run_in_background: true` (not `nohup ... &`): the harness notifies on exit, which resumes the sweep (section 1) with no user prompt. Run from the task worktree; keep the prompt, `-o` result and log in the scratchpad dir, outside the repo. On exit read the result file and the log, then sweep.
  Codex: `cd <worktree> && $FUKULOW_RUN_AS codex codex exec -m <gpt-6.1-sol|gpt-6-astra> -c 'model_reasoning_effort="<medium|high>"' --sandbox danger-full-access -o <scratch>/result.md "$(cat <scratch>/prompt.md)" < /dev/null > <scratch>/log 2>&1`
  Antigravity: `$FUKULOW_RUN_AS antigravity env HOME=<agy-home> PATH=/usr/local/argon-agy:$PATH GIT_AUTHOR_NAME=Antigravity GIT_AUTHOR_EMAIL=noreply@example.com GIT_COMMITTER_NAME=Antigravity GIT_COMMITTER_EMAIL=noreply@example.com /usr/local/argon-agy/agy -p "$(cat <scratch>/prompt.md)" --model gemini-4-argon-<low|medium|high> --print-timeout 3000s --output-format text < /dev/null > <scratch>/log 2>&1`
  Claude: the orchestrating session or a subagent works as itself; `$FUKULOW_RUN_AS claude gh|git ...` (with `< /dev/null`) only gives its GitHub commands the Claude identity. It is not a worker launcher.
- Exceptions to the area table need a line in the Issue (e.g. Codex implements the sync protocol/controller, H3 high; adapter and components stay with Antigravity).

## 5. Reviews
- AI review of an Issue or PR is at most 2 rounds in total per item; changing the reviewing AI does not reset it. Round 2 checks only changes and how earlier findings were addressed.
- Non-blocking findings become follow-up Issues, not another round. Blocking findings unresolved after round 2 -> `status:needs-decision`.
- PRs touching auth, permissions, real-time or migrations are reviewed by an AI that did not write them. AI-authored by astra: same.
- Copilot auto-review is OFF (credits). Request once per PR, by hand, when CI is green and the work is done: `gh pr edit <n> --add-reviewer @copilot`. Only for `risk:needs-review` or large code PRs. Re-request only if the maintainer asks.
- `status:human-review` only with CI green on the current head, required reviews and fixes completed, and the Copilot review (if requested) finished.
- Every Issue comment, review and PR body ends with `AI: <name> / model: <id> / effort: <level>`. Everything on GitHub is in English.

## 6. Conflicts and CI
- Conflict: in the PR worktree `git fetch origin && git merge origin/main`; resolve; run Commands; push. `docs/decisions.md` conflicts: keep both sides' current decisions (it holds only current decisions and may be rewritten within the `AGENTS.md` writing limits).
- CI does not start after a conflict-resolving merge push (no permission denial involved): push an empty commit (`git commit --allow-empty -m "Trigger CI"`).
- If `gh run rerun` is denied, never work around it (no empty commit, no other trigger): set `status:needs-decision` with the exact request for the maintainer.
- A green check on a conflicting PR is stale: resolve the conflict first, then trust only CI on the new head.

## 7. Stalls
| Symptom | Action |
|---|---|
| CI not started after merge push | empty commit (section 6) |
| Green CI is for an older sha than PR head | wait for/trigger CI on the head; never treat as green |
| Transient CI failure (network, runner, flaky) | rerun the failed job once (`gh run rerun <id> --failed`); if denied: `status:needs-decision`, no workaround; a second failure is a real failure |
| AI run ended without label/comment update | sweeper reads the PR/branch, finishes the label and writes the comment with the next step |
| Dependent Issue waits on a PR | label it `blocked`, comment "blocked by #n" (all blockers listed); the sweeper removes it once every blocker is merged (closed unmerged: re-evaluate, see section 2) |
| Async result (CI, Copilot, background AI) is overdue with no notification | check directly: `gh pr checks`, `gh pr view --json reviews`, the worker log/`-o` file and `pgrep`. Finished: handle the result. Still running: keep the current label and do other work; it is checked again at the next sweep, not in a loop. Repeated checks in one sweep are not allowed (no busy loop); the next sweep or stall check looks again. Dead without a result: relaunch (section 4). Not a human decision, so no `status:needs-decision` |
| Results arrive while orchestrator idle | run the sweep at once, do not wait for the next user message |
| An AI is stuck or needs higher effort | stop it, comment findings, restart at the next effort (section 4) |
| Needs a token, secret or denied permission | `status:needs-decision` with the exact request; continue other items |

## 8. Dependency updates and versions
- Dependabot (weekly, grouped) opens PRs for Cargo, npm, GitHub Actions, Dockerfile and Docker Compose (`/` and `/load`). Preserve tag + digest pins; resolve new digests with `docker buildx imagetools inspect <tag>`, then build and verify proxy startup. PostgreSQL major upgrades remain manual. Pin exact patch versions; Rust = `rust-toolchain.toml`, Node = `.node-version` and `web/package.json` `engines`.
- An AI reads the changelog for breaking changes, runs Commands, comments the result, then follows the PR rows of section 2: `status:human-review` (asks the maintainer to merge) only with CI green on the current head and the required review/fix cycle and Copilot (when applicable, section 5) completed.
- Rust toolchain bump: also re-verify the module-direction checker (`rustc_private`); a bump that breaks it is not merged until the checker is updated. k6 (`K6_IMAGE` in Makefile) is bumped by hand.
- Security updates are a GitHub setting (Dependabot alerts/security updates); do not claim they work until a security PR is seen.

## 9. Parallel orchestration
- One worktree per AI and branch (`/private/tmp/<topic>`, from `origin/main`). No two writers on the same files; split work by module or file set, else serialise.
- Before launching, list files each task touches; overlapping tasks run one after another. Rebase/merge `origin/main` before marking ready.
- Launch background runs and keep the sweep going; collect results as they arrive (section 1).
- Before an AI finishes it must record: the status label for the next actor, and a comment with what was done, CI state, and the next step with who does it.

## 10. Merge (only when the maintainer explicitly says so)
1. `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup,isDraft,reviews,comments`; the head sha equals the sha CI ran on (`gh run list --branch <branch> --json headSha,conclusion`); all checks pass; `mergeable` is `MERGEABLE`; not draft; required reviews finished (review verdicts are in `reviews`/`comments`, each signed with `AI:`).
2. `gh pr merge <n> --squash --match-head-commit <verified-sha>`; confirm the Issue closed; remove labels; delete branch and worktree; unblock dependents.

## 11. Labels and milestones
- Status: `status:working`, `status:ai-review`, `status:human-review`, `status:ready`, `status:needs-decision`. Filter: `label:status:human-review`.
- Others: `security` (red), `bug` (orange), `risk:needs-review`, `blocked`. Urgent = `security`/`bug` + `status:human-review`/`status:needs-decision`. No area/type/ai labels.
- Milestone = one-week sprint (at most 2 open) for work planned that week, or the undated `Backlog` for unscheduled, conditional or future work (not counted in the 2). Every Issue gets one; none means not yet triaged. Modules are expressed with labels, not milestones.
- Only the maintainer moves an Issue from `Backlog` into a sprint; an AI may propose moves at a sprint boundary.

## 12. Needs the maintainer
Merges; Issue approvals ("OK"); token/secret changes; adding a language, dependency or cost; deploy; anything in the AI prohibited list; denied permissions. Everything else proceeds without asking.

## 13. Splitting a doc
- Triggers mean "evaluate": a doc over about 40 KB; repeated merge conflicts in the same doc (any size); a major feature added to `docs/spec.md`. Not splitting is a valid outcome when the benefit is small (e.g. a doc outside normal reading such as `docs/measurements.md`).
- A split needs its own Issue approved by the maintainer; never split inside an unrelated PR. The Issue states its review mode: the cloud-session exception (top of this file) covers only doc-length CI scripts and their tests, so changing which files a CI check reads (e.g. the invariants check) follows the independent-review rules of section 5 unless the maintainer approves otherwise.
- Shape: the original path stays as the index (area name, one-line scope, link); parts live in `docs/<kind>/<area>.md`, areas aligned to modules (`auth`, `channels`, `messages`, `realtime`) or product features. No per-decision files; no new doc kinds without maintainer approval. `AGENTS.md` is never split.
- Move text verbatim, with an old location -> new location table in the PR. Check relative links, heading anchors and file-path references; fix only the reference a move breaks. No spec, decision or invariant change in the same PR; for `docs/spec.md` every guarantee keeps its meaning and scope. A constraint spanning areas is cross-referenced from each affected part.
- No check gets weaker. Splitting `docs/invariants.md` also requires: `web/scripts/check-invariants.ts` verifies every part and a new part cannot escape it; no `path::test_name` reference is lost; the 160-character Rule limit holds in every part; existence, skip and cargo reconciliation still work; negative tests for the multi-file case; no invariant changes meaning.

## 14. Operations: backup and restore (#198 C)

### Backup and custody

Use deployment `.env` (0600), pinned Node, Docker Compose and deployment `COMPOSE_PROJECT_NAME`. Scripts resolve root via `import.meta.url`; manual commands require checkout root. Backup requires PostgreSQL 18 in `db`. The drill reads the literal pinned `services.db.image` directly from tracked `compose.yml` without invoking Compose or loading secrets; update that single definition. Scripts ignore `DATABASE_URL`/suppress diagnostics. Never use `set -x`, print environment/`docker compose config`, save raw errors or put credentials/URLs in cron/arguments/logs. Keep records private.

```sh
umask 077
mkdir -p /srv/fukulow-backups
chmod 700 /srv/fukulow-backups
node scripts/backup.ts /srv/fukulow-backups
```

Use an operator-owned 0700 non-symlink directory under a trusted parent outside checkout/web root. Archives are 0600; only `fukulow-*.dump` is final after flush, dump and `pg_restore --list`. Failures preserve older archives. Never copy `.partial-*`; remove leftovers only when no backup runs. `--list` checks structure: also drill. Separately protect roles, server configuration, TLS keys and `.env`; record code revision/migration versions. Never migrate the only restored copy with newer code.

Schedule daily (e.g. 02:15 UTC), provision capacity, check success/free space daily. Keep ≥14 successful daily archives on VPS, ≥30 off VPS, and latest drilled archive until replacement passes. Pruning is manual: only finals with verified off-VPS copies, never last good copy or merely because a job ran.

Copy off VPS: operator-controlled host, 0700 directory, encrypted storage, existing SSH keys, recovery-operator access; same retention on workstations. Archives contain Messages, password/Session hashes and permissions; `pg_dump` has no encryption, SSH protects transport only. Substitute filenames/host:

```sh
sha256sum /srv/fukulow-backups/fukulow-EXAMPLE.dump
scp -p /srv/fukulow-backups/fukulow-EXAMPLE.dump backup@backup-host:/private/backups/.partial-EXAMPLE
ssh backup@backup-host 'chmod 600 /private/backups/.partial-EXAMPLE && sha256sum /private/backups/.partial-EXAMPLE'
```

Compare hashes; rename remotely on the same filesystem to `fukulow-EXAMPLE.dump`, record success, drill that copy. Interrupted copies are never final; SCP alone is insufficient.

### Disposable restore drill

```sh
node scripts/restore-drill.ts /private/backups/fukulow-EXAMPLE.dump
```

Trust archives (they execute SQL); ensure tmpfs fits, or arrange larger disposable capacity, never existing-data mounts. Random `fukulow-restore-drill-*` has no network/ports/mounts/Compose/production URL. After final-server readiness: archive check, restore with `--exit-on-error --single-transaction --no-owner --no-acl` (validating constraints), end all Sessions, bundled `pg_amcheck --install-missing --heapallindexed`. Failures fail the drill; `finally` removes container/anonymous volumes. Interrupted cleanup: inspect/remove only that exact container; never prune globally.

Drill monthly/after schema/image/backup/procedure changes; record size, image/version, counts, time, resources/results privately.

### Production recovery (maintainer-operated)

Run each command only after its predecessor succeeds; keep stderr private.

1. Retrieve trusted drilled final, verify off-VPS hash, select matching code. Declare maintenance; stop **all** app instances/writers (`docker compose -f compose.yml stop app`), disconnecting WebSockets; HTTP maintenance cannot stop writes. Close ingress. Preserve database; incident backup if readable. **Never use `compose down -v`, `pg_restore --clean`, or overwrite the only database.**
2. On production PostgreSQL 18, use a fresh incident database; replace all example names. `createdb` already exists: stop/investigate.

   ```sh
   docker compose -f compose.yml exec -T db createdb -U fukulow -O fukulow fukulow_restore_20261111
   docker compose -f compose.yml exec -T db pg_restore --list < /srv/fukulow-backups/fukulow-EXAMPLE.dump > /dev/null
   docker compose -f compose.yml exec -T db pg_restore -U fukulow -d fukulow_restore_20261111 --exit-on-error --single-transaction --no-owner --no-acl < /srv/fukulow-backups/fukulow-EXAMPLE.dump
   ```

3. **Restore revives ended Sessions/old permissions: end every Account Session and reconcile all post-snapshot permission changes before reopening.** Keep all writers stopped: auth SQL globally deletes Sessions across Accounts/Organizations, transactionally with bounded waits/empty-table assertion, without live signals. Failure: stay stopped; verify zero rows. Require Sign in; single-Session API, cookies/expired-Session clearing are insufficient.

   ```sh
   docker compose -f compose.yml exec -T db psql -X -U fukulow -d fukulow_restore_20261111 -v ON_ERROR_STOP=1 < server/src/auth/end-all-sessions.sql
   docker compose -f compose.yml exec -T db psql -X -U fukulow -d fukulow_restore_20261111 -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM public.account_sessions'
   ```

   Session revocation does **not** fix permissions. Reconcile incident records: deactivation/reactivation, Organization Memberships, owner/admin/member/guest Roles, private grants/removals, Membership revisions. Apply reviewed Organization-scoped corrections; never blindly reactivate/copy grants. Unknown changes: close affected access pending maintainer resolution.
4. Check migration versions/checksums against code (`public._sqlx_migrations`, all `success=true`); Organization/Account/Member/Channel/Message counts against records; public/private history/attribution; tenant-scoped high-water vs max Message seq; no unvalidated constraints/invalid indexes. Run drill's `pg_amcheck`, then `ANALYZE`; resolve failures before switch. Checks cannot recover post-snapshot writes.
5. App stopped: confirm names; connect `psql -X -U fukulow -d postgres -v ON_ERROR_STOP=1` through `docker compose -f compose.yml exec -T db`. Run each statement successfully outside a transaction (renames require it); block/terminate original connections:

   ```sql
   ALTER DATABASE fukulow WITH ALLOW_CONNECTIONS false;
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'fukulow' AND pid <> pg_backend_pid();
   ALTER DATABASE fukulow RENAME TO fukulow_before_restore_20261111;
   ALTER DATABASE fukulow_restore_20261111 RENAME TO fukulow;
   ```

   New database connectable, original closed. Failure: inspect names/state, stay stopped, never auto-drop/overwrite. Revert: stop writers, preserve both, rename deliberately, enable chosen database only, repeat Session/permission corrections (either copy revives authority). Keep incident copy until maintainer acceptance.
6. After the database-name switch, reapply the app role/password and database grants with matching code (`docker compose -f compose.yml run --rm migrate roles`); `--no-acl` deliberately omitted them. The private environment must supply `POSTGRES_APP_PASSWORD`; never restore role passwords from SQL. Failure: stay stopped. Restart matching code (`docker compose -f compose.yml up -d --no-deps app`), ingress closed. Check startup/migrations, liveness, fresh Sign in, old cookie/bearer rejection, Organization isolation/private denial; fresh browser: authorized history, send/retry/live delivery. Maintainer accepts permissions/checks before reopening; take/drill new backup.
7. Rehearse C8 in isolation, writes paused: hold cursor N newer than backup, restore/reconnect below N; verify `subscribed.caught_up_seq=K <` **sent** `after_seq=N`, discard window/cursor, unsubscribe, bootstrap latest history, receive live Messages without stale collisions. Unknown sends retain `client_message_id`; clamp never auto-resends. Production requires fresh Sign in/history; never admit revived Sessions for rehearsal. Run recovery-code server/web suites, including `malformed_controls_and_future_cursor_do_not_break_subscription_state` and fixture `clamp-recovery-with-cached-messages-then-live-delivery`. **C8 cannot detect restored history already beyond the old cursor; clamp alone is not recovery.**

### Recovery window

No guaranteed RPO/RTO. Daily gap: interval + dump/copy lag, longer with failures/lost VPS-only copies. Assess loss from newest verified accessible off-VPS snapshot, never job start; later writes may be lost. Measure representative recovery hardware before estimating downtime.

Initial drill conditions, result and timing limits: [measurements: backup restore drill](measurements.md#backup-restore-drill-198-c).
