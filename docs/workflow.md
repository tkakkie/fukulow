# Workflow (operating procedure for AIs)

Write cross-cutting work rules and procedures beyond code, tests and `openapi.json` ([writing rules](#13-splitting-a-doc)). Follow unprompted. Rules in `AGENTS.md`, rationale in `docs/decisions.md`.

AIs use `gh` and `git` directly as `tkakkie` by maintainer decision; the `AI:` signature identifies the AI. For Codex and Antigravity the orchestrator does all commit, push and GitHub steps (§4), including labels, comments and CI checks.

Cloud Claude Code sessions without Codex or Antigravity use the GitHub integration for Issues, PRs, labels and reviews. Maintainer-only review can replace §5's second AI only for changes confined to docs or a doc-length CI script and its tests. Exclude product code, auth, permissions, tenant scoping, real-time delivery, migrations and weakening existing CI checks. State the scope in the Issue and get maintainer approval. Required `main` ruleset checks still apply.

## 1. Sweep (run at every wake-up, notification, user message, or finished AI run)
1. Start with `node scripts/sweep-state.ts` to read state and flag mechanical inconsistencies. Only §2 decides actions. On error/incomplete listing, use `gh pr list` and `gh issue list` (`--state open --limit 200`, split at 200 via `--search 'created:<date'`), plus recent merged PRs for cleanup. Get all open PRs' mergeability (fallback `gh pr view <n> --json mergeable`). Query checks (`gh pr checks <n>` or `--json statusCheckRollup`) only as §2 requires.
2. Act on each AI-doable §2 row. List once per iteration, recheck only changed items, and repeat while AI-doable work remains.
3. Fix labels. Give statusless open items matching statuses, including green, fully reviewed PRs. Keep at most one `status:*` per item.
4. Check stalls (§7), including ended runs missing a label/comment update, stale CI and still-blocked items with merged blockers.
5. Keep the label while CI, Copilot or background AI runs are pending, never parking them in `status:human-review` or `status:needs-decision`. Runs awaiting the maintainer's go get `status:queued`. Query each once per iteration, non-blocking (`gh pr checks <n>` without `--watch`, `gh pr view --json reviews`, worker `-o` file).
6. End when AI-doable work runs out, even with async results pending. Resume on completion notification, next sweep or stall check (§7). Report pending results and items needing human action (`status:human-review` / `status:needs-decision`, question in last comment).

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
| Open PR, CONFLICTING or UNKNOWN mergeability (any status) | implementer | Before any transition towards `status:human-review`, retry UNKNOWN until known. Resolve conflicts (§6), get CI on the new head and re-verify only the delta to reviewed code | MERGEABLE and CI green on new head |
| PR draft/open, `status:working` | implementer | Run AGENTS.md Commands, push, check CI non-blocking (`gh pr checks <n>`, §1) | green CI on head and PR marked ready -> `status:ai-review` |
| PR, `status:ai-review`, CI pending or missing on head | sweeper | `gh pr checks <n>` non-blocking; do other work. Missing: §7 | CI finished on head |
| PR, `status:ai-review`, CI red | implementer or sweeper | Read failing job tail (`gh run view <id> --log-failed`) and fix. Transient: §7 | CI green on head |
| PR, `status:ai-review`, CI green, review unfinished | sweeper | Launch required AI review. Request Copilot once if due and still unrequested (§5) | verdict posted |
| PR, `status:ai-review`, blocking findings | implementer | `status:working`, fix, push, CI, comment how each finding was addressed, then `status:ai-review` for round 2 (§5) | blockers resolved |
| PR, `status:ai-review`, CI green on current head, MERGEABLE, reviews and fixes complete (§5), Copilot finished if requested | sweeper | Set `status:human-review` | label set |
| PR, `status:human-review` | maintainer | AI acts only on maintainer change request -> `status:working` | maintainer merges or comments |
| Issue/PR, `status:queued` | run owner | Wait for the run. Then record the result and set the next status | run ended |
| Issue/PR, `status:needs-decision` | maintainer | AI works elsewhere until answer, then removes label and continues | maintainer answers |
| Issue/PR, `blocked`, blocker PR merged by anyone | sweeper | Keep `blocked` until all blockers are satisfied, then remove it and set next status. Comment on the change or remaining blockers | label removed or remaining blockers named |
| Issue/PR, `blocked`, blocker PR closed unmerged | sweeper | Blocker stays unsatisfied. Reassess the need and any replacement PR. If the Issue lets an AI decide, update the blocker reference and comment; otherwise `status:needs-decision` with question in last comment | updated blocker or decision requested |
| Dependency update PR | any AI | Follow §8 | `status:human-review` |
| PR merged (recent merges in §1) | sweeper | Verify Issue closed, remove status labels, unblock dependents, delete worktree/branch | nothing left open |

## 3. Issue review path
- Require maintainer approval for new features or behaviour changes even in `docs/spec.md`, plus auth, permissions, real-time, migrations, API/schema contract changes, new dependencies/languages, cost, deploy and secrets.
- Require Issue AI review only for `risk:needs-review` (`status:ai-review`, rounds and escalation in §5). Other Issues needing approval start at `status:human-review`. Approval path ends `status:human-review` -> maintainer "OK" -> `status:ready` (#275).
- Outside those categories, AIs decide alone on bug fixes with clear repros, behaviour-preserving refactors, tests, CI, docs and patch updates, setting `status:ready` directly. Auth/permissions fixes and permission tests still need approval.
- Until DM, Mention and Search merge, pause new Issues and implementation for process improvements and doc rules, except for security, serious defects, MVP blockers or explicit maintainer requests (#275).

## 4. Roles, models, effort
- Principles (#638, #1035): no Fable; the orchestrator runs at `medium`, moving to a fresh session via a `handoff/` note after long work; `high` only for H1–H3 or security implementation, never `xhigh` or `max`; the reviewer is always a different vendor from the author; spread credit use across the three AIs.
- Models: Claude `claude-opus-5-5`, round-2 reviews `claude-sonnet-5-5`. Codex `gpt-6.2-sol`; `gpt-6.2-astra` only after two failed sol attempts (Failures below). Antigravity `gemini-4-neon-medium` and `gemini-4-neon-low`, `gemini-4-hydrogen-low` for chores; Neon `high`/`xhigh` unused.
- Choose in order; the first match decides.
  1. For H1–H3 or security implementation, use sol `high` regardless of quota. Design, Issues and contract design still use step 2 row 1. Judge by whole Issue and touched files. Size alone is insufficient. Workers finding H1–H3 or security relevance stop and report at current effort. Orchestrator restarts with sol `high` (under `quota:codex-low`, use `status:needs-decision`). H4–H6 stay `medium` with independent review. PR body lists H numbers or "none".
     - H1 auth, permissions, Organization separation, sessions.
     - H2 DB integrity, migrations, transactions, locks.
     - H3 real-time reconnect, event order, dedup, delivery.
     - H4 adding, removing or loosening a security, correctness or CI verification gate.
     - H5 behaviour-preserving conversion without an old/new comparison test.
     - H6 concurrent paths sharing state or caches, or whether a background job runs, retries or stops.
  2. Split Issues spanning work rows, or use the lowest row number if unsplittable. Implementers write tests. CI failures or conflicts needing logic changes use rows 2–4 at `medium`.

     | Row | Work | Owner |
     |---|---|---|
     | 1 | design, Issues, API contract design (`openapi.json` stays Rust-generated) | Claude |
     | 2 | Rust (server, DB, client-core) | Codex sol |
     | 3 | web (Svelte, state modules, E2E) | Antigravity Neon |
     | 4 | `load/` harness, cross-cutting test infrastructure, CI scripts | Codex sol |
     | 5 | docs, measurement records | Claude |
     | 6 | mechanical, behaviour-preserving CI, conflict and type fixes | Antigravity Hydrogen |
  3. Use `low` only for behaviour-preserving work (doc wording/typos, copy, type/lint fixes, conflicts without logic changes, round-2 delta checks, Hydrogen chores). Use `medium` otherwise, including any `docs/spec*`, `docs/decisions*` or `docs/invariants*` edit or uncertainty. Fix effort at launch regardless of line/file counts.
- Reviewers by author, round 1 `medium` / round 2 `low` (never `high`): Codex -> Neon, but H1 or security -> fresh Claude subagent; Antigravity -> sol; Claude -> Neon. The author's AI fixes findings. Same reviewer AI in rounds 1 and 2. The orchestrator may do round 2 itself for a small fix only when the author is not Claude.
- Give a fresh Claude review subagent only the diff, Issue "Done when", relevant spec, decisions, invariants and approved criteria, never orchestrator conclusions or other reviews (#505). Sign `AI: Claude Code (subagent) / model: <id> / effort: <level>`.
- Extra review at the same efforts for `load/` measurement validity, judgement, gates or aggregation changes (run procedure alone is exempt). Use Neon, or sol for Antigravity authors. One review suffices if both reviewers are the same AI.
- Quota labels: the maintainer sets them (guide: under about 30% of the weekly allowance); AIs act on the labels only.
  - `quota:codex-low`: non-H Rust and row 4 -> Claude `medium`, reviewed by Neon `medium`.
  - `quota:agy-low`: web -> Claude `medium`, reviewed by sol `medium`; chores -> sol `low`.
  - `quota:claude-low`: H1/security reviews -> Neon `medium`; docs and records -> sol `medium`; design stays with Claude.
  - If quota routes review to the author's vendor, use the third, even if labelled (reviews are the last work a low-credit AI keeps). Two labels: remaining AI implements all non-H work. Three labels, or H1–H3 or security work under `quota:codex-low`: `status:needs-decision`.
- Failures. A failure is a substantive attempt missing "Done when". Exclude single test/CI failures. Report stuck runs (§7) and count them only if restarted here. First failure -> retry same model/effort with failure details. Second sol failure (any effort) -> astra `medium`, reason in Issue. Astra failure -> `status:needs-decision`. Second Neon failure -> Claude `medium` (`status:needs-decision` under `quota:claude-low`). Second Hydrogen failure -> its rows 2–4 owner at `medium`. Second Claude failure or any post-escalation failure -> `status:needs-decision`.
- The `status:ready` comment records `Assigned: <name> / model: <id> / effort: <level> / H: <numbers or none>`. Workers follow it. A later quota label overrides it and the orchestrator posts a new `Assigned:` line.
- Antigravity: `agy models` (no Carbon, #260). Web PRs have no extra browser-check review (#275).
- Permissions (#288): all three AIs can write the task worktree, run all Commands (including throwaway Postgres DB tests), use Docker/Compose and access package registries. Never read or print secrets or `.env` values. Tests use throwaway DBs and test-only values. Fix permission problems for all three or document a reasoned exception. Sole exception: workers never commit, push or use GitHub.
- Launch workers from the task worktree via Bash with `run_in_background: true` (no `nohup ... &`). Keep prompts, `-o` results and logs in the scratchpad outside the repo. On exit notification, read the result and sweep (§1) unprompted. Use the maintainer-provisioned Antigravity login directory as `<agy-home>` (empty `HOME` prompts for login).
  Codex (CLI 0.169.0+ for 6.2 ids): `cd <worktree> && codex exec -m <gpt-6.2-sol|gpt-6.2-astra> -c 'model_reasoning_effort="<low|medium|high>"' --sandbox danger-full-access -C . -o <scratch>/result.md "$(cat <scratch>/prompt.md)" < /dev/null > <scratch>/log 2>&1` (same flags for every role; review and check prompts forbid edits).
  Antigravity: `env HOME=<agy-home> PATH=/usr/local/argon-agy:$PATH /usr/local/argon-agy/agy -p "$(cat <scratch>/prompt.md)" --model <gemini-4-neon-low|gemini-4-neon-medium|gemini-4-hydrogen-low> --dangerously-skip-permissions --print-timeout 3600s --output-format stream-json < /dev/null > <scratch>/log.jsonl 2>&1`.
  The orchestrator reviews the diff, runs checks and commits with the worker as author (`GIT_AUTHOR_NAME=<Codex|Antigravity>`, `GIT_AUTHOR_EMAIL=<codex@users.noreply.github.com|noreply@example.com>`). After a timeout, check leftover worktree changes before restarting. Claude runs as itself, as orchestrator or subagent.

  Before worker launch, write `<scratch>/context.md` (a few KB, #451) beside the prompt. Include Issue number/title, "Done when", "How I read the spec", implementer/reviewer role, no commit/push/GitHub, model/effort, H numbers and H1–H3 stop/report instruction. Quote relevant AGENTS.md rules and matching spec/decisions/invariants headings verbatim with paths and headings. List likely files, owning module, neighbouring tests and Commands. Specify report (~25 lines) with changes, tests/results, open questions and docs beyond the pack. Post via `scripts/ai-report.ts`.
  Tell both roles in prompts to read the pack first. Implementers read other docs only as needed and report each extra doc and why. Reviewers read docs normally. Read worker, CI, E2E and load summaries first (result file, failing-job tail, `load/summary.ts`).
- Exceptions to the work table need a line in the Issue.

## 5. Reviews
- At most two AI review rounds per Issue or PR, even if reviewers change. The round-1 reviewer's AI checks only changes and responses to earlier findings in round 2 (§4). Send non-blocking findings to follow-up Issues without another round. Blockers after round 2 -> `status:needs-decision` with the question in the last comment.
- Independent AI review for PRs touching auth, permissions, real-time or migrations, and astra-authored PRs.
- Copilot auto-review is off (credits). Once work is done and CI green, request once per PR (`gh pr edit <n> --add-reviewer @copilot`) only for `risk:needs-review` or large code PRs. Repeat only within the two-round cap when clearly needed, with PR reason.
- Copilot findings in unchanged code go to non-blocking follow-up Issues except security, data loss/corruption, cross-Organization leaks, serious defects caused by the PR or unmet "Done when" (#275).
- Every AI review comment, including orchestrator round-2 checks, puts `Verdict: round=<1|2> blocking=<n> nonblocking=<n>` directly above the signature (#452). Round 2 counts only open or new findings. With no verdict, the review counts as missing.

## 6. Conflicts and CI
- In the conflicting PR's worktree, `git fetch origin && git merge origin/main`, resolve, run Commands and push. Keep current `docs/decisions/` entries from both sides. Rewrite only per its index header.
- If CI does not start after the merge push and no permission was denied, push `git commit --allow-empty -m "Trigger CI"`.
- Denied `gh run rerun` -> `status:needs-decision` with exact maintainer request. No workaround (empty commit or other trigger).

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
- For dependency PRs, check the changelog for breaking changes, run Commands and comment the result. Follow §2 and §5 to `status:human-review` before asking the maintainer to merge.
- Languages per AGENTS.md; another also needs a decision entry. Tool configs may use native formats. Shared settings go in `.env.example`/Makefile. Bash: no associative arrays.
- Deliberately bump exact toolchain patches. Pin Rust in `rust-toolchain.toml` and match Node pins in `.node-version` and `web/package.json` `engines`. Dockerfile and CI follow.
- Commit library resolutions in `Cargo.lock` and `web/package-lock.json` (also `load/`). Manifests may use ranges. Change resolutions only by reviewed Dependabot PR or deliberate, reasoned, reviewed bump (#297). `@playwright/test` stays exact and matches its browser image (`scripts/check-versions.ts`). CI runs `cargo deny` and `node scripts/npm-audit-gate.ts web load`. The audit gate rejects high/critical advisories without valid exceptions. Non-major fixes or stale exceptions fail the gate and require exception removal.
- `scripts/check-versions.ts` fails CI on drift from `versions.json` (#512). `version-check.yml` (weekly/manual) opens `Version check` for updates, support ends, failures or notes, else closes it.
- Apply security fixes immediately outside sprints. Take library patches/minors via weekly Dependabot. Keep Rust within 1–2 stable releases and Node on even LTS (next within 6 months of LTS start). One Issue per major (Svelte, Vite, TypeScript, sqlx, axum, …) for maintainer decision. Plan PostgreSQL majors and OS base image updates manually about yearly. Bump `K6_IMAGE` in Makefile manually. Open an Issue for anything within 6 months of support end.
- Module direction uses pinned Rust and built web assets. On each Rust bump re-verify the `rustc_private` checker and fix it before merge if broken: `rustup component add rustc-dev && rustfmt --check --edition 2024 scripts/module-direction.rs && node --test scripts/check-module-direction.test.ts && node scripts/check-module-direction.ts`
- Dependabot alerts/security updates are a GitHub setting. Claim them working only after seeing a security PR.

## 9. Parallel orchestration
- List task files before launch. One worktree per AI/branch from `origin/main`. Split by module or file set, serialise overlaps. Rebase or merge `origin/main` before marking ready.
- Measurements: any time, only on the maintainer's go in chat, after pre-run gates ([rules](../load/harness-core/README.md)); criteria unchanged. One run per host; `HOST-BUSY` and idle rule (no builds, workers, E2E) bind only that host.
- Before finishing, set the next actor's status and comment what was done, CI state, next step and actor.

## 10. Merge (only when the maintainer explicitly says so)
1. `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup,isDraft,reviews,comments`. Verify CI ran on the head SHA (`gh run list --branch <branch> --json headSha,conclusion`), all checks pass, the PR is `MERGEABLE` with `isDraft: false`, and required reviews finished (`reviews`/`comments` with signed `AI:` verdicts).
2. `gh pr merge <n> --squash --match-head-commit <verified-sha>`.
3. Confirm Issue closed, remove labels, delete branch and worktree, and unblock dependents. Other merges use §2 cleanup.

## 11. Labels and milestones
- Status names and meanings are in AGENTS.md.
- Other labels are in AGENTS.md (`security` red, `bug` orange; quota labels §4). Urgent = `security`/`bug` + `status:human-review`/`status:needs-decision`. No area/type/ai labels.
- One-week sprints (max two open) hold that week's planned work. Use undated `Backlog` outside the cap for unscheduled, conditional or future work. No milestone means untriaged. Modules use labels, never milestones.
- Only the maintainer moves `Backlog` Issues into a sprint. AIs may propose moves at sprint boundaries.

## 12. Needs the maintainer
Merges; Issue approvals ("OK"); token/secret changes; adding a language, dependency or cost; deploy; anything in the AI prohibited list; denied permissions. Everything else proceeds without asking.

## 13. Splitting a doc
- Record decisions with their rationale and rejected alternatives, cross-client contracts, cross-cutting rules (e.g. lock order), denial requirements, accepted limits and approved but unimplemented behaviour. Mark that behaviour as proposed and keep only its contract once implemented. Omit REST shapes, status tables, test name lists in the spec, implementation history and restatements of code constants.
- `web/scripts/check-doc-budgets.ts` caps `AGENTS.md` and `docs/` per file and in total (fixed 684 KiB, 8def9c2 + 10%, #603). Prune or merge first.
- New/raised doc budgets (including total or splits) and Wasm cap raises (#1128) require the corresponding maintainer-set `docs:budget-raise` or `wasm:budget-raise` label (CI). Review checks the PR-body reason and link to explicit maintainer approval. A shared-account label actor is insufficient evidence.
- Wasm PR bodies record raw and gzip before/after (review). CI computes no delta.
- Consider a split if pruning or merging leaves a doc over budget, conflicts recur or `docs/spec.md` gains a major feature. Split when justified. Keep `docs/measurements.md` small per its header (#560).
- A split needs a PR reason and its own maintainer-approved Issue with review mode. Keep splits out of unrelated PRs. Changing CI file coverage needs independent review (§5) unless the maintainer approves otherwise.
- Keep the original path as index (area, one-line scope, link). Parts are `docs/<kind>/<area>.md` by module (`auth`, `channels`, `messages`, `realtime`) or feature. No per-decision files. New doc kinds need maintainer approval. Never split `AGENTS.md`.
- Pure splits move text verbatim. Include an old -> new location table in the PR. Fix broken relative links, heading anchors and file-path references. Keep changes to spec guarantees, decisions and invariants out of the PR. Preserve their meaning and scope. Link cross-area rules to their one home where useful.
- Preserve CI checks and budget every resulting file. An invariants split keeps every `path::test_name` and invariant meaning, ensures `web/scripts/check-invariants.ts` checks every part and preserves existence, skip and cargo reconciliation checks. Add multi-file negative tests.

## 14. Focused SQL measurements
- Keep each harness in `load/sql-probes/` in Git: SQL, run script and reproduction steps. Synthetic data only, with no secrets or real data (#540).
- Record per run: commit SHA, PostgreSQL image digest, DB settings, measured role and its RLS check, Custom/Generic/Auto, `pg_prepared_statements` state, cache condition and repetitions.
- Keep raw `EXPLAIN` JSON and samples. Git cap is 1 MiB compressed total per run; never split to evade it. Store larger runs in a dedicated Cloudflare R2 measurement bucket separate from backups, with its own least-privilege credentials. Retain at least 365 days and while current results or decisions cite the data, with no auto-expiry. Then review and delete only unneeded data. Bucket creation, credentials and activation need separate approval. Until then, record data as not stored. A temporary directory or expiring CI artifact alone is insufficient.
- Link harness, steps, raw data location, SHA-256 and retention end in `docs/measurements.md`.

## 15. Releases
Only the maintainer pushes, moves or deletes `v*` tags or changes GHCR package settings; `release.yml` publishes them from green `main` commits ([process](spec/deployment.md#releases-808)). Rollback: migrations are append-only and forward-only, and startup refuses unknown ones, so an older image cannot run on a newer schema; past a migration, restore the pre-upgrade backup.

## 16. Tests
- Web: Svelte DOM tests extend `web/src/svelte-dom-test-helpers.ts`, never copy it. Tests may import `web/scripts`; product code never does. Request deadlines use the shared helper (target until #834 merges).
- Rust (#844). Await concurrency conditions via observable barriers (lock waiter, gate `entered()`, counter), never fixed sleeps. Fixed sleeps need a comment that duration is the subject. Time out every test-barrier await so regressions fail without hanging.
- Add a shared helper before the third copy: domain-free ones (gates, lock waits, plan walkers, SQLSTATE checks) in `crate::test_support`, table-writing ones in the owning module as `#[cfg(test)] pub(crate)`. No module edge for a test helper.
- Tests may move with code (#852 R1), never renamed. Keep named wrappers for bodies moved to helpers and separate denial case names. Use plain `mod x;` files only, no `#[path]`/`include!`. Moving inline `mod tests` to a file keeps its runner name. New child modules add a segment. PRs list changed runner names and update invariants rows and `contract/realtime/` citations (CI), plus references in docs, `--exact` strings and subprocess tests (review).

## 17. Retiring load harnesses (#1136)

Delete a `load/` unit (subdir or top-level script plus tests/helpers) only if all hold:
- Its Issues are closed; no open Issue/PR cites its paths.
- No current baseline, decision or open acceptance in `docs/measurements.md` cites it.
- No live unit imports it; no manifest hash-pins it. Keep shared infrastructure (`harness-core`, `launcher`, `proxy-target.ts`).
- No other references (`docs/spec*`, `docs/decisions*`, `docs/invariants*`, `docs/workflow.md`, CI workflows, `Makefile`, `load/package.json` scripts).

One PR per unit, appending to `load/measurements-archive.md` its paths, the last full 40-hex SHA containing it and a restore command (checkout, lockfile deps, pinned Node). Of tests, update only the test glob and `tsconfig.json` includes; no reruns. Past results, verdicts and evidence stay unchanged. Widening needs maintainer approval.
