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
- Dependabot (weekly, grouped) opens PRs for Cargo, npm, GitHub Actions, Docker. Pin exact patch versions; Rust = `rust-toolchain.toml`, Node = `.node-version` and `web/package.json` `engines`.
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
- Milestone = one-week sprint (at most 2 open); every Issue gets one. Modules are expressed with labels, not milestones.

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

Run from the deployment checkout with its existing private `.env` (0600), the Node version in `.node-version`, Docker Compose, and the same `COMPOSE_PROJECT_NAME` used to deploy. `compose.yml` uses `postgres:18`; the script uses `pg_dump` and `pg_restore` inside that project's `db` container and refuses a non-18 dump client. It does not use `DATABASE_URL`, put credentials in command arguments, or write a connection string into a backup. Do not use `set -x`, print the environment or `docker compose config`, or save raw tool errors: they can disclose credentials. Docker/Compose/PostgreSQL error diagnostics are deliberately suppressed by these scripts.

```sh
umask 077
mkdir -p /srv/fukulow-backups
chmod 700 /srv/fukulow-backups
node scripts/backup.ts /srv/fukulow-backups
```

The directory must be owned by the operator, mode 0700, and not a symlink; use a trusted parent outside the checkout and web root. Each archive is 0600. The script streams a custom-format snapshot to `.partial-*/archive` on the destination filesystem, flushes it, requires successful `pg_dump` and `pg_restore --list`, then renames it to a unique `fukulow-*.dump`. Only that final name is a published artifact. Failures preserve older backups and remove their temporary directory; a machine crash/forced kill can leave `.partial-*`, which must never be copied as backups and may be removed after confirming no backup is running. `--list` checks archive structure, not every data block; a successful restore drill is also required. A dump is one database, not cluster roles, server configuration, TLS keys or `.env`; retain those separately in existing protected configuration/secret custody. Match the backup with its application Git revision and applied migration versions in a private operator record. Do not start newer migrations against the only restored copy.

Recommended initial schedule: one successful backup daily (for example 02:15 UTC using the existing host scheduler). Verify success and free disk space daily. Keep at least the latest 14 successful daily archives on the VPS and 30 off the VPS, and always retain the latest successfully drilled archive until its replacement passes. Prune only named final archives whose verified off-VPS copy exists; never prune because the latest attempt merely ran, and never remove the last known good copy. There is no automatic deletion in the script. Provision capacity before enabling the schedule; no paid storage service is introduced here.

Copy each successful archive over existing SSH/SCP to an operator-controlled machine outside this VPS. Use a 0700 destination directory and encrypted storage there; archives contain Message bodies, password hashes, Account Session hashes and Membership/Role history. Example, substituting a real final filename and existing host/account:

```sh
sha256sum /srv/fukulow-backups/fukulow-EXAMPLE.dump
scp -p /srv/fukulow-backups/fukulow-EXAMPLE.dump backup@backup-host:/private/backups/.partial-EXAMPLE
ssh backup@backup-host 'chmod 600 /private/backups/.partial-EXAMPLE && sha256sum /private/backups/.partial-EXAMPLE'
```

Compare the two hashes, then rename the remote `.partial-EXAMPLE` to `fukulow-EXAMPLE.dump` on that host's same filesystem and record copy success. Never accept an interrupted copy as final. Run the drill on the off-VPS copy too; SCP alone does not prove recoverability. Use existing SSH key custody, never passwords or URLs in cron, arguments or logs. Restrict access to recovery operators and apply the same retention policy to workstation copies. Backups are not encrypted by `pg_dump`; SSH protects transport only.

### Disposable restore drill

```sh
node scripts/restore-drill.ts /private/backups/fukulow-EXAMPLE.dump
```

The drill creates a randomly named `fukulow-restore-drill-*` PostgreSQL 18 container with networking disabled, no published port, no host/database mounts and a tmpfs data directory. It never uses Compose or a production URL. It waits for the final PostgreSQL server, verifies the archive list, restores into its fresh `fukulow` database with `--exit-on-error --single-transaction --no-owner --no-acl`, ends every restored Account Session, and runs PostgreSQL's bundled `pg_amcheck --install-missing --heapallindexed` (the bundled `amcheck` extension is installed only in this disposable database). Constraints are recreated/validated during restore. Any failure fails the drill; the container and anonymous volumes are removed in `finally`. An OS crash/forced kill may prevent cleanup: inspect and remove only the exact drill container from that run, never prune Docker globally. Use a trusted archive: a database archive can execute SQL. Tmpfs must fit the restored database; for a larger drill, arrange an explicitly disposable environment with sufficient capacity before running, without mounting existing data.

Record archive size, image/version, dataset counts, elapsed time, machine/resources and check results privately for each drill. Repeat at least monthly and after schema, image, backup or recovery-procedure changes. The initial measured drill and its limits are recorded below; this is a recoverability check, not a benchmark or availability promise.

### Production recovery (maintainer-operated)

1. Select a trusted, successfully drilled final archive and the matching application revision. Verify its off-VPS hash after retrieval. Declare maintenance, stop **all** application instances and other writers (`docker compose -f compose.yml stop app` in the deployment project), and keep public access closed until the checks below finish. Stopping the app disconnects WebSockets; do not rely on an HTTP maintenance page to stop writes. Preserve the current database and take a separate incident backup if readable. Never use `compose down -v`, `pg_restore --clean`, or restore over the only existing database.
2. Restore to a new, explicitly named database on the production PostgreSQL 18 instance. The following recovery name is an example: choose a fresh incident-specific name. `createdb` must succeed; if it already exists, stop and investigate instead of reusing it. Run each step only after the preceding command succeeds; keep stderr private.

   ```sh
   docker compose -f compose.yml exec -T db createdb -U fukulow -O fukulow fukulow_restore_20261111
   docker compose -f compose.yml exec -T db pg_restore --list < /srv/fukulow-backups/fukulow-EXAMPLE.dump > /dev/null
   docker compose -f compose.yml exec -T db pg_restore -U fukulow -d fukulow_restore_20261111 --exit-on-error --single-transaction --no-owner --no-acl < /srv/fukulow-backups/fukulow-EXAMPLE.dump
   ```

3. **A restore can revive ended Account Sessions and old Membership/Role/private Channel permission state. Ending every Account Session and re-checking all Membership/permission changes since the snapshot are mandatory before reopening.** The existing API ends one Session only. With every writer still stopped, run the offline global command below (SQL lives in its owning `auth` module). It deletes only `public.account_sessions`, uses a transaction and bounded lock/statement waits, and asserts that none remain; failure means keep the app stopped. This intentionally global recovery operation covers every Account and Organization. It does not emit live revocation signals; stopping every app instance first is essential. Verify zero rows afterwards. All users must Sign in again; clearing only browser cookies or expired Sessions is insufficient.

   ```sh
   docker compose -f compose.yml exec -T db psql -X -U fukulow -d fukulow_restore_20261111 -v ON_ERROR_STOP=1 < server/src/auth/end-all-sessions.sql
   docker compose -f compose.yml exec -T db psql -X -U fukulow -d fukulow_restore_20261111 -v ON_ERROR_STOP=1 -Atc 'SELECT count(*) FROM public.account_sessions'
   ```

   Reconcile against the incident/change record: deactivations/reactivations, Organization Memberships, owner/admin/member/guest Roles, and private Channel grants/removals (including Membership revision). Revocation of Sessions does **not** correct restored permissions. Reapply the intended current state through reviewed, Organization-scoped maintenance changes before admitting users; do not blindly reactivate Members or copy old private grants. If the changes cannot be established, keep affected access closed and ask the maintainer to resolve them.
4. Check the restored schema/migration versions and checksums against the selected application's migrations (`public._sqlx_migrations`, all `success=true`); compare expected Organization, Account, Member, Channel and Message counts with the snapshot/incident record. Verify representative public/private Channel history and attribution, and tenant-scoped sequence high-water marks against the maximum Message seq. Check that PostgreSQL reports no unvalidated constraints or invalid indexes. Run `pg_amcheck` as in the drill against the recovery database, then `ANALYZE`. These checks do not prove that omitted/lost post-snapshot writes exist. Resolve any failed check before switching. Keep diagnostic output, hashes and permission review records private.
5. Switch database names while the app is stopped, preserving the original. Connect `psql -X -U fukulow -d postgres -v ON_ERROR_STOP=1` through `docker compose -f compose.yml exec -T db` and execute the following SQL only after confirming the database names. Each statement must succeed. `ALLOW_CONNECTIONS false` blocks new connections to the original; terminating its remaining connections enforces the write stop. Database renames cannot run inside a transaction. If a step fails, inspect names/state and keep the app stopped; never automatically drop or overwrite a database.

   ```sql
   ALTER DATABASE fukulow WITH ALLOW_CONNECTIONS false;
   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'fukulow' AND pid <> pg_backend_pid();
   ALTER DATABASE fukulow RENAME TO fukulow_before_restore_20261111;
   ALTER DATABASE fukulow_restore_20261111 RENAME TO fukulow;
   ```

   The new database keeps `ALLOW_CONNECTIONS true`; the preserved database stays closed. If reverting is necessary, keep writers stopped, preserve both databases, rename deliberately, re-enable connections only on the chosen database, and repeat Session invalidation and permission reconciliation there too. Starting either copy can revive credentials/authority. Never discard the incident copy until the maintainer accepts recovery.
6. Restart the matching app (`docker compose -f compose.yml up -d --no-deps app`) while public ingress remains closed. Check startup/migration success, liveness, fresh Sign in, rejection of pre-restore cookie/bearer credentials, Organization isolation and private Channel denial. Confirm authorized history, send/retry and live delivery from a fresh browser. Then reopen ingress only after the maintainer accepts the permission reconciliation and checks. Take and drill a new backup after recovery.
7. Confirm C8 cursor clamp/resync from `docs/spec.md`: in an isolated rehearsal hold a client window with cursor N newer than the backup, restore the older history and reconnect while that Channel remains below N. Verify `subscribed.caught_up_seq=K <` the **sent** `after_seq=N`, invalidation of the old confirmed window/cursor, unsubscribe and fresh latest-history bootstrap, and subsequent live Messages without stale collisions. Unknown sends keep their original `client_message_id`; clamp never resends automatically. The mandatory Session invalidation in production forces Sign in instead of preserving old sockets, so rehearse the clamp independently, without admitting revived production Sessions. The executable server test `malformed_controls_and_future_cursor_do_not_break_subscription_state` and shared client fixture `clamp-recovery-with-cached-messages-then-live-delivery` cover these two sides; run the server and web suites on the recovery revision. **C8 cannot detect a restored history that has already grown beyond the old cursor.** Keep writes paused during the clamp rehearsal and force fresh Sign in/history after production recovery; cursor clamp alone is not a complete recovery procedure.

### Recovery window and measured drill

No guaranteed RPO or RTO. With daily successful snapshots, the nominal recoverable-write gap is up to the backup interval plus dump/copy lag; failed jobs or loss of the latest VPS-only copy can make it longer. Use the timestamp of the newest verified, accessible off-VPS snapshot to assess actual loss, not the scheduler's last start time. Writes after that snapshot may be lost.

The measured drill time covers container startup, restore, ending Sessions and heap/index checks only. It excludes backup creation, download/image pull, incident detection, finding the right archive, permission reconciliation, database switch, app restart, client checks and human approval. Production dataset size, disk, CPU, contention and failure modes differ; measure a representative drill on the recovery hardware before estimating outage duration. No measured drill time is a guaranteed recovery deadline.

Initial drill (2026-11-11 JST, #198 C): **1.82 seconds**, on Apple M5/arm64 macOS, Docker 29.9.3 with 10 CPUs / 8,319,438,848 bytes VM memory, Node 26.13.0, cached `postgres:18` = PostgreSQL 18.6 (`sha256:5a5a84b19854a9ffaa54082c166ff4ec27473a361e496e5ea167f298f2da9722`). A fresh, separately named Compose source had all 9 repository migrations, 2 Organizations, 1 Account, 2 Members with owner/guest Roles, 2 public/private Channels and grants, 2,000 synthetic Messages (seq 1–1,000 per Channel), and 3 Account Sessions. `node scripts/backup.ts` produced a 133,556-byte archive; `node scripts/restore-drill.ts` restored it with constraints, ended all Sessions and passed heap/index checks in a separate network-disabled tmpfs container, then removed it. This tiny synthetic dataset, cached image and memory-backed destination do not estimate VPS disk restore time or a full production outage. The source retained its original 2,000 Messages and 3 Sessions.
