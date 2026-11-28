# Workflow (operating procedure for AIs)

Write cross-cutting work rules and procedures beyond code, tests and `openapi.json` ([writing rules](#13-splitting-a-doc)). Follow unprompted. Rules in `AGENTS.md`, rationale in `docs/decisions.md`.

AIs use `gh` and `git` directly as `tkakkie` by maintainer decision; the `AI:` signature identifies the AI. For Codex and Antigravity the orchestrator does all commit, push and GitHub steps (§4), including labels, comments and CI checks.

Cloud Claude Code sessions without Codex or Antigravity use the GitHub integration for Issues, PRs, labels and reviews. Maintainer-only review may replace §5's second AI only for docs-only changes or changes limited to a doc-length CI script and its tests. Exclude product code, auth, permissions, tenant scoping, real-time delivery, migrations and weakening any existing CI check. State this scope in the Issue; get maintainer approval. The `main` ruleset's required checks still apply.

## 1. Sweep (run at every wake-up, notification, user message, or finished AI run)
1. Use `node scripts/sweep-state.ts` first, not separate lists. It reads state and flags mechanical inconsistencies. Only §2 decides actions. On error or incomplete listing, use `gh pr list` and `gh issue list` (`--state open --limit 200`; at 200 results split by `--search 'created:<date'`), plus recent merged PRs for cleanup. Get every open PR's mergeability (fallback: `gh pr view <n> --json mergeable`). Query checks (`gh pr checks <n>` or `--json statusCheckRollup`) only when the §2 row needs them.
2. Act on each AI-doable §2 row. List once per sweep iteration. After acting, re-check only changed items. Repeat while AI-doable work remains.
3. Fix labels. An open item without a status gets its matching status, including green PRs whose reviews are done. Keep at most one `status:*` per item.
4. Check stalls (§7), including ended runs missing a label/comment update, stale CI and still-blocked items with merged blockers.
5. For pending CI, Copilot or background AI runs, keep the current label. Never park them in `status:human-review` or `status:needs-decision`. A run waiting for the maintainer's go gets `status:queued`. Query each once per sweep iteration, non-blocking (`gh pr checks <n>` without `--watch`, `gh pr view --json reviews`, worker `-o` file).
6. End the iteration when no AI-doable work remains, even with async results pending. Resume on a completion notification, the next sweep or a stall check (§7). Report items needing human action (`status:human-review` / `status:needs-decision`, question in last comment) and pending results.

## 2. State -> next action
| Item, label | Who acts | Next action | Step ends when |
|---|---|---|---|
| Issue, no status | author AI | Add "Done when" and milestone. Feature: "How I read the spec" (3–5 lines, spec terms). Follow §3 | `status:ai-review`, `status:human-review` or `status:ready` (AI-decidable, with the §4 `Assigned:` line) |
| Issue, `status:ai-review`, unreviewed | independent AI | Review and comment (§5) | verdict posted; no blocking findings -> `status:human-review` |
| Issue, `status:ai-review`, round 1 blocked | author AI | Fix, comment how each finding was addressed and request round 2 (§5 delta) | round 2 verdict with no blocking findings -> `status:human-review`; blocking findings remain -> `status:needs-decision` |
| Issue, `status:human-review` | maintainer | AI does other work | maintainer comments "OK" |
| Issue, `status:human-review` with maintainer "OK" | any AI | Replace label with `status:ready` and post the §4 `Assigned:` line | ready |
| Issue, `status:ready`, unblocked | implementer named by `Assigned:` (§4) | With "Done when", set `status:working`, create branch/worktree, implement and open draft PR | PR links `Closes #n`; Issue stays `status:working` |
| Issue, `status:ready` and `blocked` | none | Wait until the sweeper removes `blocked` (below) | `blocked` removed |
| Issue, `status:working` | implementer | Follow its PR row. No PR and no activity: §7 | PR merged, Issue closed |
| Open PR, CONFLICTING or UNKNOWN mergeability (any status) | implementer | Precedes every transition towards `status:human-review`. Re-query UNKNOWN until known. Resolve conflicts (§6), get CI on the new head and check if the resolution touched reviewed code. Re-verify only that delta | MERGEABLE and CI green on new head |
| PR draft/open, `status:working` | implementer | Run AGENTS.md Commands, push, check CI non-blocking (`gh pr checks <n>`, §1) | green CI on head and PR marked ready -> `status:ai-review` |
| PR, `status:ai-review`, CI pending or missing on head | sweeper | `gh pr checks <n>` non-blocking; do other work. Missing: §7 | CI finished on head |
| PR, `status:ai-review`, CI red | implementer or sweeper | Read failing job tail (`gh run view <id> --log-failed`) and fix. Transient: §7 | CI green on head |
| PR, `status:ai-review`, CI green, review unfinished | sweeper | Launch required AI review. Request Copilot once if due and still unrequested (§5) | verdict posted |
| PR, `status:ai-review`, blocking findings | implementer | `status:working`, fix, push, CI, comment how each finding was addressed, then `status:ai-review` for round 2 (§5) | blockers resolved |
| PR, `status:ai-review`, CI green on current head, MERGEABLE, reviews and fixes complete (§5), Copilot finished if requested | sweeper | Set `status:human-review` | label set |
| PR, `status:human-review` | maintainer | AI acts only on maintainer change request -> `status:working` | maintainer merges or comments |
| Issue/PR, `status:queued` | run owner | Wait for the run. Then record the result and set the next status | run ended |
| Issue/PR, `status:needs-decision` | maintainer | AI works elsewhere until answer, then removes label and continues | maintainer answers |
| Issue/PR, `blocked`, blocker PR merged by anyone | sweeper | Remove `blocked` and set the next status only when all blockers are satisfied. Otherwise retain `blocked`. Comment on the change or what remains | label removed or remaining blockers named |
| Issue/PR, `blocked`, blocker PR closed unmerged | sweeper | Blocker stays unsatisfied. Reassess the need and any replacement PR. If the Issue lets an AI decide, update the blocker reference and comment; otherwise `status:needs-decision` with question in last comment | updated blocker or decision requested |
| Dependency update PR | any AI | Follow §8 | `status:human-review` |
| PR merged (recent merges in §1) | sweeper | Verify Issue closed, remove status labels, unblock dependents, delete worktree/branch | nothing left open |

## 3. Issue review path
- Require maintainer approval for every new feature or behaviour change, even if in `docs/spec.md`, plus auth, permissions, real-time, migrations, API or schema contract changes, new dependencies or languages, cost, deploy and secrets.
- Require Issue AI review only for `risk:needs-review` (`status:ai-review`, rounds and escalation in §5). Other Issues needing approval start at `status:human-review`. Approval path ends `status:human-review` -> maintainer "OK" -> `status:ready` (#275).
- When no maintainer-required category applies, the AI decides alone for bug fixes with a clear repro, behaviour-preserving refactors, tests, CI, docs and patch updates, and sets `status:ready` directly. Auth/permissions fixes and permission tests still need approval.
- Until DM, Mention and Search are merged, process improvements and doc rules are paused (no new Issue, no implementation of an existing one), except for security, serious defects, MVP blockers or an explicit maintainer request (#275).

## 4. Roles, models, effort
- Principles (#638, #1035): no Fable; the orchestrator runs at `medium`, moving to a fresh session via a `handoff/` note after long work; `high` only for H1–H3 or security implementation, never `xhigh` or `max`; the reviewer is always a different vendor from the author; spread credit use across the three AIs.
- Models: Claude `claude-opus-5-5`, round-2 reviews `claude-sonnet-5-5`. Codex `gpt-6.2-sol`; `gpt-6.2-astra` only after two failed sol attempts (Failures below). Antigravity `gemini-4-neon-medium` and `gemini-4-neon-low`, `gemini-4-hydrogen-low` for chores; Neon `high`/`xhigh` unused.
- Choose in order; the first match decides.
  1. Risk: H1–H3 or security implementation -> sol `high`; quota labels never move it. Design, Issues and contract design for it still follow step 2 row 1. Judge from the whole Issue and touched files, never size alone. A worker finding H1–H3 or security relevance stops and reports without raising its effort; the orchestrator restarts with sol `high` (under `quota:codex-low`: `status:needs-decision`). H4–H6 stay `medium` with independent review. List H numbers (or "none") in the PR body.
     - H1 auth, permissions, Organization separation, sessions.
     - H2 DB integrity, migrations, transactions, locks.
     - H3 real-time reconnect, event order, dedup, delivery.
     - H4 adding, removing or loosening a security, correctness or CI verification gate.
     - H5 behaviour-preserving conversion without an old/new comparison test.
     - H6 concurrent paths sharing state or caches, or whether a background job runs, retries or stops.
  2. Work: split an Issue spanning rows; if it cannot be split, the lowest row number decides. The implementing AI writes the tests. A CI failure or conflict needing a logic change goes to rows 2–4 at `medium`.

     | Row | Work | Owner |
     |---|---|---|
     | 1 | design, Issues, API contract design (`openapi.json` stays Rust-generated) | Claude |
     | 2 | Rust (server, DB, client-core) | Codex sol |
     | 3 | web (Svelte, state modules, E2E) | Antigravity Neon |
     | 4 | `load/` harness, cross-cutting test infrastructure, CI scripts | Codex sol |
     | 5 | docs, measurement records | Claude |
     | 6 | mechanical, behaviour-preserving CI, conflict and type fixes | Antigravity Hydrogen |
  3. Effort: `low` only for behaviour-preserving work (wording or typo doc edits, copy, type and lint fixes, conflicts without logic changes, round-2 delta checks, Hydrogen chores). `medium` for everything else, including any edit to `docs/spec*`, `docs/decisions*` or `docs/invariants*`, and when unsure. Line or file counts never change effort; effort is fixed at launch.
- Reviewers by author, round 1 `medium` / round 2 `low` (never `high`): Codex -> Neon, but H1 or security -> fresh Claude subagent; Antigravity -> sol; Claude -> Neon. The author's AI fixes findings. Round 2 stays with the round-1 reviewer's AI. The orchestrator may do round 2 itself for a small fix only when the author is not Claude.
- A Claude reviewer is a fresh subagent given only the diff, Issue "Done when", relevant spec, decisions, invariants and approved criteria, never orchestrator conclusions or other reviews (#505). Sign `AI: Claude Code (subagent) / model: <id> / effort: <level>`.
- Changes to `load/` measurement validity, judgement, gates or aggregation (not run procedure alone) get an extra review at the same efforts: Neon, or sol when the author is Antigravity. One review covers both when the two reviewers are the same AI.
- Quota labels: the maintainer sets them (guide: under about 30% of the weekly allowance); AIs act on the labels only.
  - `quota:codex-low`: non-H Rust and row 4 -> Claude `medium`, reviewed by Neon `medium`.
  - `quota:agy-low`: web -> Claude `medium`, reviewed by sol `medium`; chores -> sol `low`.
  - `quota:claude-low`: H1/security reviews -> Neon `medium`; docs and records -> sol `medium`; design stays with Claude.
  - Reviews never move to the author's vendor; the third vendor reviews then, even if labelled (reviews are the last work a low-credit AI keeps). Two labels: the remaining AI implements all non-H work. Three labels, or H1–H3 or security work under `quota:codex-low`: `status:needs-decision`.
- Failures: a substantive attempt that misses "Done when"; one failing test or CI run does not count, and a stuck run (§7) is reported, not counted, unless restarted here. First failure -> same model and effort with the failure details. Second sol failure (any effort) -> astra `medium`, reason in the Issue. Astra failure -> `status:needs-decision`. Second Neon failure -> Claude `medium` (`status:needs-decision` under `quota:claude-low`). Second Hydrogen failure -> its rows 2–4 owner at `medium`. Second Claude failure, or a failure after any escalation -> `status:needs-decision`.
- The comment that sets `status:ready` records `Assigned: <name> / model: <id> / effort: <level> / H: <numbers or none>`. The worker follows it and does not re-choose. A later quota label overrides it, and the orchestrator posts a new `Assigned:` line.
- Antigravity: `agy models` (no Carbon, #260). Web PRs have no extra browser-check review (#275).
- Permissions (#288): all three AIs can write the task worktree, run all Commands (including throwaway Postgres DB tests), use Docker/Compose and access package registries. Never read or print secrets or `.env` values. Tests use throwaway DBs and test-only values. Fix permission problems for all three or document a reasoned exception. Sole exception: workers never commit, push or use GitHub.
- Orchestrator: launch each worker from the task worktree using the Bash tool with `run_in_background: true` (no `nohup ... &`). Keep prompt, `-o` result and logs in the scratchpad outside the repo. Exit notifications resume §1 unprompted: read the result, then sweep. `<agy-home>`: the maintainer-provisioned Antigravity login directory (an empty `HOME` prompts for login).
  Codex (CLI 0.169.0+ for 6.2 ids): `cd <worktree> && codex exec -m <gpt-6.2-sol|gpt-6.2-astra> -c 'model_reasoning_effort="<low|medium|high>"' --sandbox danger-full-access -C . -o <scratch>/result.md "$(cat <scratch>/prompt.md)" < /dev/null > <scratch>/log 2>&1` (same flags for every role; review and check prompts forbid edits).
  Antigravity: `env HOME=<agy-home> PATH=/usr/local/argon-agy:$PATH /usr/local/argon-agy/agy -p "$(cat <scratch>/prompt.md)" --model <gemini-4-neon-low|gemini-4-neon-medium|gemini-4-hydrogen-low> --dangerously-skip-permissions --print-timeout 3600s --output-format stream-json < /dev/null > <scratch>/log.jsonl 2>&1`.
  The orchestrator reviews the diff, runs checks and commits with the worker as author (`GIT_AUTHOR_NAME=<Codex|Antigravity>`, `GIT_AUTHOR_EMAIL=<codex@users.noreply.github.com|noreply@example.com>`). After a timeout, check the worktree's leftover changes before restarting. Claude runs as the orchestrator or as a subagent, each as itself.

  Before launching a worker, write `<scratch>/context.md` (a few KB, #451) next to the prompt. Include Issue number, title, "Done when" and "How I read the spec"; role (implementer/reviewer), limits (no commit/push/GitHub), model, effort, H numbers and H1–H3 stop/report instruction; touched-area AGENTS.md rules and matching spec, decisions and invariants headings, quoted verbatim with path and heading; likely files, owning module, neighbouring tests and Commands; report format (changes, tests/results, open questions, docs read beyond the pack; ~25 lines). Post reports with `scripts/ai-report.ts`.
  Implementers read the pack first, other docs only if needed, reporting each extra doc and why; reviewers start with the pack and read docs normally. State this in prompts. Read worker, CI, E2E and load summaries first (result file, failing-job tail, `load/summary.ts`).
- Exceptions to the work table need a line in the Issue.

## 5. Reviews
- At most two AI review rounds total per Issue or PR, regardless of reviewer changes. Round 2 checks changes and responses to earlier findings only, by the round-1 reviewer's AI (§4). Non-blocking findings go to follow-up Issues and never trigger another round. Blocking findings left after round 2 -> `status:needs-decision` with the question in the last comment.
- Independent AI review for PRs touching auth, permissions, real-time or migrations, and astra-authored PRs.
- Copilot auto-review is off (credits). Manually request once per PR (`gh pr edit <n> --add-reviewer @copilot`) only for `risk:needs-review` or large code PRs, when work is done and CI is green. Request again only within the two-round cap when clearly needed and state why in the PR.
- Copilot findings in unchanged code become non-blocking follow-up Issues except for security, data loss or corruption, cross-Organization information leak, a serious defect caused by this PR or unmet "Done when" (#275).
- Every AI review comment, including orchestrator round-2 checks, puts `Verdict: round=<1|2> blocking=<n> nonblocking=<n>` directly above the signature (#452). Round 2 counts only open or new findings. With no verdict, the review counts as missing.

## 6. Conflicts and CI
- In the conflicting PR's worktree, `git fetch origin && git merge origin/main`, resolve, run Commands and push. Keep both sides' current `docs/decisions/` entries. Rewrite only within that index header's writing rules.
- If CI does not start after the merge push and no permission was denied, push `git commit --allow-empty -m "Trigger CI"`.
- A denied `gh run rerun` gets `status:needs-decision` with the exact maintainer request and no workaround (empty commit or other trigger).

## 7. Stalls
| Symptom | Action |
|---|---|
| Green CI on older SHA | Stale: wait for or trigger CI on the head |
| Transient CI failure (network, runner, flaky) | Rerun failed jobs once (`gh run rerun <id> --failed`). Denied: §6. Second failure is real |
| AI run ended without updating label/comment | Sweeper reads PR/branch, finishes label and comments with next step |
| Dependent Issue waits on PR | Label `blocked`, comment "blocked by #n" for all blockers. Sweeper follows §2 on merged or unmerged closure |
| Async CI, Copilot or worker overdue without notification | Check directly once per sweep (§1 commands plus worker log). Handle finished results, or keep label and work elsewhere while running. Recheck at next sweep/stall check. Relaunch dead workers without results (§4). |
| AI stuck or needs higher effort | Stop it and comment findings. Restart only under §4 Failures (`high` only for §4 step 1), counting it as a failure; otherwise `status:needs-decision` |
| Needs token, secret or denied permission | `status:needs-decision` with exact request. Continue other work |

## 8. Dependency updates and versions
- Web sync (#465): `cargo install wasm-bindgen-cli --version 0.2.130 --locked`. `npm --prefix web run wasm` builds release wasm for the pinned Rust target. Check/test/build regenerate it. CI runs wasm Vitest and builds. Every bundle must contain the Rust bridge, glue and exactly one wasm asset. `contract/realtime/core-traces.json` runs in native Rust and wasm tests (#467). Use the original checkout for historical TS measurements.
- To intentionally regenerate `core-traces.json` (deduplicated values/steps) and `core-boundary.json` from the current Rust core: `UPDATE_CONTRACT=1 cargo test -p fukulow-client-core --test differential`. Tests write them only with this opt-in.
- Every dependency-resolving Cargo command in CI and the image uses `--locked`, so a `Cargo.toml`/`Cargo.lock` mismatch fails without re-resolving (#313). Dependabot Cargo PRs update the lock. Local Commands may omit it.
- Dependabot PRs: preserve tag + digest pins. Resolve new digests via `docker buildx imagetools inspect <tag>`, then build and verify proxy startup.
- For dependency PRs, read the changelog for breaking changes, run Commands and comment the result. Follow §2 and §5 to `status:human-review`, asking the maintainer to merge only when those gates pass.
- Languages per AGENTS.md; another also needs a decision entry. Tool configs may use native formats. Shared settings go in `.env.example`/Makefile. Bash: no associative arrays.
- Deliberately bump exact toolchain patches. Pin Rust in `rust-toolchain.toml` and match Node pins in `.node-version` and `web/package.json` `engines`. Dockerfile and CI follow.
- Commit resolved library pins in `Cargo.lock` and `web/package-lock.json` (also `load/`). Manifests may use ranges. Change resolutions only by reviewed Dependabot PR or deliberate reviewed bump with a reason, never incidentally (#297). `@playwright/test` stays exact and matches its browser image (`scripts/check-versions.ts`). CI runs `cargo deny` and `node scripts/npm-audit-gate.ts web load`. The audit gate rejects high/critical advisories unless covered by a valid exception. A non-major fix or stale exception fails the gate and requires exception removal.
- `scripts/check-versions.ts` fails CI on drift from `versions.json` (#512). `version-check.yml` (weekly/manual) opens `Version check` for updates, support ends, failures or notes, else closes it.
- Apply security fixes at once, outside sprints. Take library patch/minor updates via weekly Dependabot. Keep Rust within 1–2 stable releases, Node on even LTS (next within 6 months of LTS start). Majors (Svelte, Vite, TypeScript, sqlx, axum, …) get one Issue each for maintainer decision. Plan PostgreSQL major upgrades and OS base image updates by hand about yearly. Manually bump `K6_IMAGE` in Makefile. Open an Issue for anything within 6 months of support end.
- Module direction uses pinned Rust and built web assets. On each Rust bump re-verify the `rustc_private` checker and fix it before merge if broken: `rustup component add rustc-dev && rustfmt --check --edition 2024 scripts/module-direction.rs && node --test scripts/check-module-direction.test.ts && node scripts/check-module-direction.ts`
- Dependabot alerts/security updates are a GitHub setting. Claim them working only after seeing a security PR.

## 9. Parallel orchestration
- Before launch list each task's files. One worktree per AI/branch, from `origin/main`. Split by module or file set and serialise overlaps. Rebase or merge `origin/main` before marking ready.
- Measurements: any time, only on the maintainer's go in chat, after pre-run gates ([rules](../load/harness-core/README.md)); criteria unchanged. One run per host; `HOST-BUSY` and idle rule (no builds, workers, E2E) bind only that host.
- Before finishing, set the next actor's status and comment what was done, CI state, next step and actor.

## 10. Merge (only when the maintainer explicitly says so)
1. `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup,isDraft,reviews,comments`. Verify CI ran on the head SHA (`gh run list --branch <branch> --json headSha,conclusion`), all checks pass, the PR is `MERGEABLE` with `isDraft: false`, and required reviews finished (`reviews`/`comments` with signed `AI:` verdicts).
2. `gh pr merge <n> --squash --match-head-commit <verified-sha>`.
3. Confirm Issue closed, remove labels, delete branch and worktree, and unblock dependents. Other merges use §2 cleanup.

## 11. Labels and milestones
- Status names and meanings are in AGENTS.md.
- Other labels are in AGENTS.md (`security` red, `bug` orange; quota labels §4). Urgent = `security`/`bug` + `status:human-review`/`status:needs-decision`. No area/type/ai labels.
- A one-week sprint (max two open) holds work planned for that week. Use undated `Backlog` for unscheduled, conditional or future work, outside that cap. No milestone means untriaged. Use labels for modules, never milestones.
- Only the maintainer moves `Backlog` Issues into a sprint. AIs may propose moves at sprint boundaries.

## 12. Needs the maintainer
Merges; Issue approvals ("OK"); token/secret changes; adding a language, dependency or cost; deploy; anything in the AI prohibited list; denied permissions. Everything else proceeds without asking.

## 13. Splitting a doc
- Record decisions with their rationale and rejected alternatives, cross-client contracts, cross-cutting rules (e.g. lock order), denial requirements, accepted limits and approved but unimplemented behaviour. Mark that behaviour as proposed and keep only its contract once implemented. Omit REST shapes, status tables, test name lists in the spec, implementation history and restatements of code constants.
- `web/scripts/check-doc-budgets.ts` caps `AGENTS.md` and `docs/` per file and in total (fixed 684 KiB, 8def9c2 + 10%, #603). Prune or merge first.
- Adding or raising a doc budget (including total or splits) or raising the Wasm cap (#1128) requires the corresponding maintainer-set label (CI), `docs:budget-raise` or `wasm:budget-raise`. Review checks the PR-body reason and link to explicit maintainer approval. The shared account makes the label actor insufficient evidence.
- Wasm PRs record raw and gzip before and after in the body (review); CI computes no delta.
- Consider a split if pruning or merging leaves a doc over budget, conflicts recur or `docs/spec.md` gains a major feature. Split when justified. Keep `docs/measurements.md` small per its header (#560).
- A split needs a PR reason and its own maintainer-approved Issue with review mode. Keep splits out of unrelated PRs. Changing CI file coverage needs independent review (§5) unless the maintainer approves otherwise.
- Keep the original path as index (area, one-line scope, link). Parts are `docs/<kind>/<area>.md` by module (`auth`, `channels`, `messages`, `realtime`) or feature. No per-decision files. New doc kinds need maintainer approval. Never split `AGENTS.md`.
- Pure split: move verbatim. Include an old -> new location table in the PR. Fix relative links, heading anchors and file-path references the move breaks. Keep changes to spec guarantees, decisions and invariants out of the split PR and preserve their meaning and scope. Link cross-area rules to their one home where useful.
- Preserve CI checks and budget every resulting file. An invariants split keeps every `path::test_name` and invariant meaning, ensures `web/scripts/check-invariants.ts` checks every part and preserves existence, skip and cargo reconciliation checks. Add multi-file negative tests.

## 14. Focused SQL measurements
- Keep each harness in `load/sql-probes/` in Git: SQL, run script and reproduction steps. Synthetic data only, with no secrets or real data (#540).
- Record per run: commit SHA, PostgreSQL image digest, DB settings, measured role and its RLS check, Custom/Generic/Auto, `pg_prepared_statements` state, cache condition and repetitions.
- Keep raw `EXPLAIN` JSON and samples. In Git: at most 1 MiB compressed per run in total, never split to evade the cap. Larger: a dedicated Cloudflare R2 measurement bucket, separate from backups, with its own least-privilege credentials. Retain at least 365 days and while current results or decisions cite it; no automatic expiry; after that, review and delete only unneeded data. Creating, credentialing and enabling the bucket need separate approval; until then record the data as not stored. A temporary directory or expiring CI artifact alone never counts as stored.
- The `docs/measurements.md` entry links harness, steps, raw data location, SHA-256 and retention end.

## 15. Releases
Only the maintainer pushes, moves or deletes `v*` tags or changes GHCR package settings; `release.yml` publishes them from green `main` commits ([process](spec/deployment.md#releases-808)). Rollback: migrations are append-only and forward-only, and startup refuses unknown ones, so an older image cannot run on a newer schema; past a migration, restore the pre-upgrade backup.

## 16. Tests
- Web: Svelte DOM tests extend `web/src/svelte-dom-test-helpers.ts`, never copy it. Tests may import `web/scripts`; product code never does. Request deadlines use the shared helper (target until #834 merges).
- Rust (#844): wait on an observable barrier (lock waiter, gate `entered()`, counter), never infer a concurrency condition from a fixed sleep; a fixed sleep needs a comment saying its duration is the subject. Every await on a test barrier has a timeout, so a regression fails, not hangs.
- Add a shared helper before the third copy: domain-free ones (gates, lock waits, plan walkers, SQLSTATE checks) in `crate::test_support`, table-writing ones in the owning module as `#[cfg(test)] pub(crate)`. No module edge for a test helper.
- Moving tests (#852 R1): a test may move with its code, never renamed; a body moved into a helper keeps its named wrapper, and denial cases stay separately named. Plain `mod x;` files only, no `#[path]`/`include!`. An inline `mod tests` moved to a file keeps its runner name; a new child module adds a segment. The PR lists changed runner names and updates invariants rows and `contract/realtime/` citations (CI) and references in docs, `--exact` strings and subprocess tests (review).
