# Workflow (operating procedure for AIs)

Write cross-cutting work rules and procedures beyond code, tests and `openapi.json` ([writing rules](#13-splitting-a-doc)). Follow unprompted. Rules in `AGENTS.md`, rationale in `docs/decisions.md`.

AIs use `gh` and `git` directly as `tkakkie` by maintainer decision. The §5 signature identifies the AI. For Codex and Antigravity workers, the orchestrator handles all commit, push and GitHub steps (§4), including labels, comments and CI checks. Never push to `main`. See §10 for merge authority.

In Claude Code cloud sessions without Codex or Antigravity, use the GitHub integration for Issues, PRs, labels and reviews. Maintainer-only review may replace §5's second AI only for docs-only changes or changes limited to a doc-length CI script and its tests. Exclude product code, auth, permissions, tenant scoping, real-time delivery, migrations and weakening any existing CI check. State this scope in the Issue and get maintainer approval. The `main` ruleset still requires green `web`, `server` and `docker` checks on the head.

## 1. Sweep (run at every wake-up, notification, user message, or finished AI run)
1. Use `node scripts/sweep-state.ts` first in place of separate lists. It reads state and flags mechanical inconsistencies. Only §2 decides actions. On error or incomplete listing, use `gh pr list --state open --limit 200 --json number,title,labels,headRefOid` and `gh issue list --state open --limit 200 --json number,title,labels,milestone`. At 200 results, split with `--search 'created:<date'` until exhausted. For cleanup also use `gh pr list --state merged --limit 30 --json number,headRefName,labels,mergedAt`. Get every open PR's mergeability (`gh pr view <n> --json mergeable` in fallback). For separate check queries, use `gh pr view <n> --json statusCheckRollup` or `gh pr checks <n>` only when the §2 row needs them.
2. Act on each AI-doable §2 row. List once per sweep iteration. After acting, re-check only changed items (`gh pr view <n>` / `gh issue view <n>`). Repeat while AI-doable work remains.
3. Fix labels. An open item without a status gets its matching status, including green PRs whose reviews are done. Keep at most one `status:*` per item.
4. Check stalls (§7), including ended runs missing a label/comment update, stale CI and still-blocked items with merged blockers.
5. For pending CI, Copilot or background AI runs, keep the current label. Never park them in `status:human-review` or `status:needs-decision`. Use one non-blocking query per waiting item per sweep iteration (`gh pr checks <n>` without `--watch`, `gh pr view --json reviews`, worker `-o` file and `pgrep`).
6. End the iteration when no AI-doable work remains, even with async results pending. Resume on a completion notification, the next sweep (wake-up or user message) or a stall check (§7), whichever comes first. Report items needing human action (`status:human-review` / `status:needs-decision`, question in last comment) and pending results.

## 2. State -> next action
| Item, label | Who acts | Next action | Step ends when |
|---|---|---|---|
| Issue, no status | author AI | Add "Done when" and milestone. Feature: "How I read the spec" (3–5 lines, spec terms). Follow §3 | `status:ai-review`, `status:human-review` or `status:ready` (AI-decidable, with the §4 `Assigned:` line) |
| Issue, `status:ai-review`, unreviewed | independent AI | Review and comment (§5) | verdict posted; no blocking findings -> `status:human-review` |
| Issue, `status:ai-review`, round 1 blocked | author AI | Fix, comment how each finding was addressed and request round 2 (§5 delta) | round 2 verdict with no blocking findings -> `status:human-review`; blocking findings remain -> `status:needs-decision` |
| Issue, `status:human-review` | maintainer | AI does other work | maintainer comments "OK" |
| Issue, `status:human-review` with maintainer "OK" | any AI | Replace label with `status:ready` and post the §4 `Assigned:` line | ready |
| Issue, `status:ready`, unblocked | implementer named by `Assigned:` (§4) | With "Done when", set `status:working`, create branch/worktree, implement and open draft PR | PR links `Closes #n`; Issue stays `status:working` |
| Issue, `status:ready` and `blocked` | none | Wait until every named blocker is satisfied (each blocker PR merged) and the sweeper removes `blocked` (below) | `blocked` removed |
| Issue, `status:working` | implementer | Follow its PR row. No PR and no activity: §7 | PR merged, Issue closed |
| Open PR, CONFLICTING or UNKNOWN mergeability (any status) | implementer | Precedes every transition towards `status:human-review`. Re-query UNKNOWN until known. Resolve conflicts (§6), get CI on the new head and check if the resolution touched reviewed code. Re-verify only that delta | MERGEABLE and CI green on new head |
| PR draft/open, `status:working` | implementer | Run AGENTS.md Commands, push, check CI non-blocking (`gh pr checks <n>`, §1) | green CI on head and PR marked ready -> `status:ai-review` |
| PR, `status:ai-review`, CI pending or missing on head | sweeper | `gh pr checks <n>` non-blocking; do other work. Missing: §7 | CI finished on head |
| PR, `status:ai-review`, CI red | implementer or sweeper | Read failing job tail (`gh run view <id> --log-failed`) and fix. Transient: §7 | CI green on head |
| PR, `status:ai-review`, CI green, review unfinished | sweeper | Launch required AI review. Request Copilot once if due and still unrequested (§5) | verdict posted |
| PR, `status:ai-review`, blocking findings | implementer | `status:working`, fix, push, CI, comment how each finding was addressed, then `status:ai-review` for round 2 (§5) | blockers resolved |
| PR, `status:ai-review`, CI green on current head, MERGEABLE, reviews and fixes complete (§5), Copilot finished if requested | sweeper | Set `status:human-review` | label set |
| PR, `status:human-review` | maintainer | AI acts only on maintainer change request -> `status:working` | maintainer merges or comments |
| Issue/PR, `status:needs-decision` | maintainer | AI works elsewhere until answer, then removes label and continues | maintainer answers |
| Issue/PR, `blocked`, blocker PR merged by anyone | sweeper | Remove `blocked` and set the next status only when all blockers are satisfied. Otherwise retain `blocked`. Comment on the change or what remains | label removed or remaining blockers named |
| Issue/PR, `blocked`, blocker PR closed unmerged | sweeper | Blocker remains unsatisfied. Reassess whether the work is needed and whether there is a replacement PR. If an AI can decide from the Issue, update the blocker reference and comment. Otherwise `status:needs-decision` with question in last comment | updated blocker or decision requested |
| Dependency update PR | any AI | Follow §8 | `status:human-review` |
| PR merged (recent merges in §1) | sweeper | Verify Issue closed, remove status labels, unblock dependents, delete worktree/branch | nothing left open |

## 3. Issue review path
- Require maintainer approval for every new feature or behaviour change, even if in `docs/spec.md`, plus auth, permissions, real-time, migrations, API or schema contract changes, new dependencies or languages, cost, deploy and secrets.
- Require Issue AI review only for `risk:needs-review` (`status:ai-review`, rounds and escalation in §5). Other Issues needing approval start at `status:human-review`. Approval path ends `status:human-review` -> maintainer "OK" -> `status:ready` (#275).
- When no maintainer-required category applies, the AI decides alone for bug fixes with a clear repro, behaviour-preserving refactors, tests, CI, docs and patch updates, and sets `status:ready` directly. Auth/permissions fixes and permission tests still need approval.
- Until DM, Mention and Search are merged, process improvements and doc rules are paused (no new Issue, no implementation of an existing one), except for security, serious defects, MVP blockers or an explicit maintainer request (#275).

## 4. Roles, models, effort
- Principles (#638): no Fable; `high` only for H1–H3 or security implementation, never `xhigh` or `max`; Claude uses `claude-opus-5-5` only; the reviewer is always a different vendor from the author; spread credit use across the three AIs.
- Models: Claude `claude-opus-5-5`. Codex `gpt-6.2-sol`; `gpt-6.2-astra` only after two failed sol attempts (Failures below). Antigravity `gemini-4-neon-medium` and `gemini-4-neon-low`, `gemini-4-hydrogen-low` for chores; Neon `high`/`xhigh` unused.
- Choose in order; the first match decides.
  1. Risk: H1–H3 or security implementation -> sol `high`; quota labels never move it. Design, Issues and contract design for it still follow step 2 row 1. Judge from the whole Issue and touched files; size alone never qualifies. A worker that finds H1–H3 or security relevance stops and reports, never raising its own effort; the orchestrator restarts with sol `high` (under `quota:codex-low`: `status:needs-decision`). H4–H6 stay `medium` with independent review. List H numbers (or "none") in the PR body.
     - H1 auth, permissions, Organization separation, sessions.
     - H2 DB integrity, migrations, transactions, locks.
     - H3 real-time reconnect, event order, dedup, delivery.
     - H4 adding, removing or loosening a security, correctness or CI verification gate.
     - H5 behaviour-preserving conversion without an old/new comparison test.
     - H6 concurrent paths sharing state or caches, or whether a background job runs, retries or stops.
  2. Work: split an Issue spanning rows; if it cannot be split, the lowest row number decides. The implementing AI writes the tests. A CI failure or conflict needing a logic change goes to rows 2–4 at `medium`.

     | Row | Work | Owner |
     |---|---|---|
     | 1 | design, Issues, API contract design (`openapi.json` stays generated from Rust) | Claude |
     | 2 | Rust (server, DB, client-core) | Codex sol |
     | 3 | web (Svelte, state modules, E2E) | Antigravity Neon |
     | 4 | cross-cutting test infrastructure, CI scripts, docs, measurement records | Claude |
     | 5 | mechanical, behaviour-preserving CI, conflict and type fixes | Antigravity Hydrogen |
  3. Effort: `low` only for behaviour-preserving work (wording or typo doc edits, copy, type and lint fixes, conflicts without logic changes, round-2 delta checks, Hydrogen chores). `medium` for everything else, including any edit to `docs/spec*`, `docs/decisions*` or `docs/invariants*`, and when unsure. `high` only for step 1. Line or file counts never change effort; effort is fixed at launch.
- Reviewers by author, round 1 `medium` / round 2 `low` (never `high`): Codex, not H1–H3 or security -> Neon; Codex, H1–H3 or security -> fresh Claude subagent; Antigravity -> sol; Claude -> Neon. Round 2 stays with the round-1 reviewer's AI. The orchestrator may do round 2 itself for a small fix only when the author is not Claude.
- A Claude reviewer is a fresh subagent given only the diff, Issue "Done when", relevant spec, decisions, invariants and approved criteria, never orchestrator conclusions or other reviews (#505). Sign `AI: Claude Code (subagent) / model: claude-opus-5-5 / effort: <level>`.
- Changes to `load/` measurement validity, judgement, gates or aggregation (not run procedure alone) get an extra review at the same efforts: a fresh Claude subagent, or sol when the author is Claude. One review covers both when the two reviewers are the same AI.
- Quota labels: the maintainer sets them (guide: under about 30% of the weekly allowance); AIs act on the labels only.
  - `quota:codex-low`: non-H Rust -> Claude `medium`, reviewed by Neon `medium`.
  - `quota:agy-low`: web -> Claude `medium`, reviewed by sol `medium`; chores -> sol `low`.
  - `quota:claude-low`: measurement and high-risk reviews -> Neon `medium`; CI, docs and records -> sol `medium`; design stays with Claude.
  - Reviews never move to the author's vendor. If a label would make the reviewer the author's vendor, the third vendor reviews even if labelled: reviews are the last work a low-credit AI keeps. Two labels: the remaining AI implements all non-H work. Three labels, or H1–H3 or security work under `quota:codex-low`: `status:needs-decision`.
- Failures: a substantive attempt that misses "Done when"; one failing test or CI run does not count, and a stuck run (§7) is reported, not counted, unless restarted here. First failure -> same model and effort with the failure details. Second sol failure (any effort) -> astra `medium`, reason recorded in the Issue. Astra failure -> `status:needs-decision`. Second Neon failure -> Claude `medium` (`status:needs-decision` under `quota:claude-low`). Second Hydrogen failure -> its rows 2–4 owner at `medium`. Second Claude failure, or a failure after any escalation -> `status:needs-decision`.
- The comment that sets `status:ready` records `Assigned: <name> / model: <id> / effort: <level> / H: <numbers or none>`. The worker follows it and does not re-choose. A later quota label overrides it, and the orchestrator posts a new `Assigned:` line.
- Antigravity runs `/usr/local/argon-agy/agy` (`agy models`, no Carbon, #260). Web PRs have no extra browser-check review (#275).
- Permissions (#288): all three AIs can write the task worktree, run all Commands (including throwaway Postgres DB tests), use Docker/Compose and access package registries. Never read or print secrets or `.env` values. Tests use throwaway databases and test-only values. Fix permission problems for all three or document a reasoned exception here. Workers never commit, push or use GitHub because one orchestrator owns commits, attribution and GitHub state. This is the sole exception.
- Orchestrator: launch each worker from the task worktree using the Bash tool with `run_in_background: true` (no `nohup ... &`). Harness exit notifications resume §1 unprompted. Keep prompt, `-o` result and logs in the scratchpad outside the repo. Read Codex result and log or Antigravity log on exit, then sweep. `<agy-home>` is the maintainer-provisioned Antigravity login directory shared across worktrees. An empty `HOME` prompts for login.
  Codex (CLI 0.169.0 or later; older CLIs reject the 6.2 model ids): `cd <worktree> && codex exec -m <gpt-6.2-sol|gpt-6.2-astra> -c 'model_reasoning_effort="<low|medium|high>"' --sandbox danger-full-access -C . -o <scratch>/result.md "$(cat <scratch>/prompt.md)" < /dev/null > <scratch>/log 2>&1` (the same flag to implement, fix, review or check; a review or check prompt says not to edit files; the log streams progress).
  Antigravity: `env HOME=<agy-home> PATH=/usr/local/argon-agy:$PATH /usr/local/argon-agy/agy -p "$(cat <scratch>/prompt.md)" --model <gemini-4-neon-low|gemini-4-neon-medium|gemini-4-hydrogen-low> --dangerously-skip-permissions --print-timeout 3600s --output-format stream-json < /dev/null > <scratch>/log.jsonl 2>&1` (JSON events, one per line, plus any stderr diagnostics, so progress is visible during the run; read the final report at the end of the log).
  Both worker prompts forbid commits, pushes and GitHub. The orchestrator reviews the diff, runs checks and commits with the worker as author (`GIT_AUTHOR_NAME=<Codex|Antigravity>`, `GIT_AUTHOR_EMAIL=<codex@users.noreply.github.com|noreply@example.com>`). Check changes left in the worktree after timeout before restarting. Claude runs as the orchestrator or as a subagent, each as itself.

  Before launching a worker, write `<scratch>/context.md` next to the prompt, aiming for a few KB (#451). Include Issue number, title, "Done when" and "How I read the spec"; role (implementer/reviewer), limits (no commit/push/GitHub), model, effort, H numbers and H1–H3 stop/report instruction; touched-area AGENTS.md rules and matching spec, decisions and invariants headings, quoted verbatim with path and heading; likely files, owning module, neighbouring tests and Commands; report format (changes, tests/results, open questions, docs read beyond the pack).
  Implementers read the pack first, other docs only if needed, and report each extra doc and why. Reviewers start with the pack and read docs normally. State these reading rules in their prompts. Read summaries first for worker, CI, E2E and load results (result file, failing-job tail, `load/summary.ts`). Use full logs when diagnosis or consistency requires them.
- Exceptions to the work table need a line in the Issue (e.g. Codex implements the sync protocol/controller, H3 high; adapter and components stay with Antigravity).

## 5. Reviews
- At most two AI review rounds total per Issue or PR, regardless of reviewer changes. Round 2 checks changes and responses to earlier findings only, by the round-1 reviewer's AI (§4). Non-blocking findings go to follow-up Issues and never trigger another round. Blocking findings left after round 2 -> `status:needs-decision` with the question in the last comment.
- Independent AI review for PRs touching auth, permissions, real-time or migrations, and astra-authored PRs.
- Copilot auto-review is off (credits). Manually request once per PR (`gh pr edit <n> --add-reviewer @copilot`) only for `risk:needs-review` or large code PRs, when work is done and CI is green. Request again only within the two-round cap when clearly needed and state why in the PR.
- Copilot findings in unchanged code become non-blocking follow-up Issues except for security, data loss or corruption, cross-Organization information leak, a serious defect caused by this PR or unmet "Done when" (#275).
- PR entry to `status:human-review` follows §2's CI, mergeability, review, fix and Copilot gates.
- Every AI review comment, including orchestrator round-2 checks, puts `Verdict: round=<1|2> blocking=<n> nonblocking=<n>` directly above the signature (#452). Round 2 counts only open or new findings. With no verdict, the review counts as missing.
- End every Issue comment, review and PR body with `AI: <name> / model: <id> / effort: <level>`. Everything on GitHub is in English.

## 6. Conflicts and CI
- In the conflicting PR's worktree, `git fetch origin && git merge origin/main`, resolve, run Commands and push. Keep both sides' current `docs/decisions/` entries. Rewrite only within that index header's writing rules. Existing green CI is stale. Require CI on the new head (§2).
- If CI fails to start after the conflict-resolving merge push, and no permission denial is involved, push `git commit --allow-empty -m "Trigger CI"`.
- If `gh run rerun` is denied, set `status:needs-decision` with the exact maintainer request. No workaround (including empty commit or other trigger).

## 7. Stalls
| Symptom | Action |
|---|---|
| CI not started after merge push | empty commit (section 6) |
| Green CI on older SHA | Wait for or trigger CI on the head. Treat the older result as stale |
| Transient CI failure (network, runner, flaky) | Rerun failed jobs once (`gh run rerun <id> --failed`). Denied: §6. Second failure is real |
| AI run ended without updating label/comment | Sweeper reads PR/branch, finishes label and comments with next step |
| Dependent Issue waits on PR | Label `blocked`, comment "blocked by #n" for all blockers. Sweeper follows §2 on merged or unmerged closure |
| Async CI, Copilot or worker overdue without notification | Check directly once per sweep (§1 commands plus worker log). Handle finished results, or keep label and work elsewhere while running. Recheck at next sweep/stall check. Relaunch dead workers without results (§4). No `status:needs-decision` for waiting |
| Results arrive while orchestrator idle | Sweep immediately, without waiting for user |
| AI stuck or needs higher effort | Stop it and comment findings. It counts as a failure only if restarted under §4 Failures. Restart at `high` only for §4 step 1; otherwise follow §4 Failures or report with `status:needs-decision` |
| Needs token, secret or denied permission | `status:needs-decision` with exact request. Continue other work |

## 8. Dependency updates and versions
- Web sync (#465): `cargo install wasm-bindgen-cli --version 0.2.130 --locked`. `npm --prefix web run wasm` builds release wasm for the pinned Rust target. Check/test/build regenerate it. `scripts/check-versions.ts` guards CLI/crate/Docker/CI pins. CI runs wasm Vitest and builds. Every bundle must contain the Rust bridge, glue and exactly one wasm asset. `contract/realtime/core-traces.json` runs in native Rust and wasm tests (#467). Use the original checkout for historical TS measurements.
- To intentionally regenerate `core-traces.json` (deduplicated values/steps) and `core-boundary.json` from the current Rust core: `UPDATE_CONTRACT=1 cargo test -p fukulow-client-core --test differential`. Tests write them only with this opt-in.
- CI and image Cargo build/run/clippy/test/nextest/check (every dependency-resolving command) use `--locked`. A mismatch between `Cargo.toml` and `Cargo.lock` fails without re-resolving (#313). Dependabot Cargo PRs update the lock and must pass. Local Commands may omit the flag. Non-resolving commands such as fmt are out of scope.
- Dependabot opens grouped weekly PRs for Cargo, npm, GitHub Actions, Dockerfile and Docker Compose (`/` and `/load`). Preserve tag + digest pins. Resolve new digests via `docker buildx imagetools inspect <tag>`, then build and verify proxy startup.
- For dependency PRs, read the changelog for breaking changes, run Commands and comment the result. Follow §2 and §5 to `status:human-review`, asking the maintainer to merge only when those gates pass.
- Languages: Rust, TypeScript (web, tests, Node scripts), SQL and short bash. Others need maintainer approval and a decision entry. Tool configs may use native formats. Shared settings go in `.env.example`/Makefile. Bash: `#!/usr/bin/env bash`, `set -euo pipefail`, bash 3.2 (no associative arrays). Over ~20 lines or shared variables -> TypeScript.
- Deliberately bump exact toolchain patches. Pin Rust in `rust-toolchain.toml` and match Node pins in `.node-version` and `web/package.json` `engines`. Dockerfile and CI follow.
- Commit resolved library pins in `Cargo.lock` and `web/package-lock.json` (also `load/`). Manifests may use ranges. Change resolutions only by reviewed Dependabot PR or deliberate reviewed bump with a reason, never incidentally (#297). `@playwright/test` stays exact and matches its browser image (`scripts/check-versions.ts`). CI runs `cargo deny` and `node scripts/npm-audit-gate.ts web load`. The audit gate rejects high/critical advisories unless covered by a valid exception. A non-major fix or stale exception fails the gate and requires exception removal.
- `versions.json` lists each pinned component, its file, support end and update source (#512). `scripts/check-versions.ts` fails CI on drift. `version-check.yml` (weekly, `workflow_dispatch`) maintains one `Version check` Issue for newer releases and support ends.
- Apply security fixes at once, outside sprints. Take library patch/minor updates via weekly Dependabot. Keep Rust within 1–2 stable releases, Node on even LTS (next within 6 months of LTS start). Majors (Svelte, Vite, TypeScript, sqlx, axum, …) get one Issue each for maintainer decision. Plan PostgreSQL major upgrades and OS base image updates by hand about yearly. Perform PostgreSQL major upgrades manually. Manually bump `K6_IMAGE` in Makefile. Open an Issue for anything within 6 months of support end.
- Module direction uses pinned Rust and built web assets. On each Rust bump re-verify the `rustc_private` checker and fix it before merge if broken: `rustup component add rustc-dev && rustfmt --check --edition 2024 scripts/module-direction.rs && node --test scripts/check-module-direction.test.ts && node scripts/check-module-direction.ts`
- Dependabot alerts/security updates are a GitHub setting. Claim them working only after seeing a security PR.

## 9. Parallel orchestration
- Before launch list each task's files. One worktree per AI/branch (`/private/tmp/<topic>`, from `origin/main`). Split by module or file set and serialise overlaps. Rebase or merge `origin/main` before marking ready.
- Run workers in background (§4), sweep and collect results as they arrive (§1).
- Before finishing, set the next actor's status and comment what was done, CI state and the next step with its actor.

## 10. Merge (only when the maintainer explicitly says so)
1. `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup,isDraft,reviews,comments`. Verify CI ran on the head SHA (`gh run list --branch <branch> --json headSha,conclusion`), all checks pass, the PR is `MERGEABLE` with `isDraft: false`, and required reviews finished (`reviews`/`comments` with signed `AI:` verdicts).
2. `gh pr merge <n> --squash --match-head-commit <verified-sha>`.
3. Confirm Issue closed, remove labels, delete branch and worktree, and unblock dependents. Other merges use §2 cleanup.

## 11. Labels and milestones
- Status names and meanings are in AGENTS.md. Filter with `label:status:human-review`.
- `security` (red), `bug` (orange), `risk:needs-review`, `blocked`, and `quota:codex-low`, `quota:agy-low`, `quota:claude-low` (maintainer-set, §4). Urgent = `security`/`bug` + `status:human-review`/`status:needs-decision`. No area/type/ai labels.
- Every Issue gets a milestone. A one-week sprint (max two open) holds work planned for that week. Use undated `Backlog` for unscheduled, conditional or future work, outside that cap. No milestone means untriaged. Use labels for modules, never milestones.
- Only the maintainer moves `Backlog` Issues into a sprint. AIs may propose moves at sprint boundaries.

## 12. Needs the maintainer
Merges; Issue approvals ("OK"); token/secret changes; adding a language, dependency or cost; deploy; anything in the AI prohibited list; denied permissions. Everything else proceeds without asking.

## 13. Splitting a doc
- Write only what code, tests and `openapi.json` cannot tell. Record decisions with their rationale and rejected alternatives, cross-client contracts, cross-cutting rules (e.g. lock order), denial requirements, accepted limits and approved but unimplemented behaviour. Mark that behaviour as proposed and keep only its contract once implemented. Give each fact one home and update it in place by replacement or merge. Omit REST shapes, status tables, test name lists in the spec, implementation history and restatements of code constants.
- `web/scripts/check-doc-budgets.ts` records and enforces a byte budget per file under `docs/` and for `AGENTS.md`. Prune or merge first when over budget.
- Evaluate a split if pruning or merging leaves the doc over budget, the same doc has repeated merge conflicts at any size or a major feature is added to `docs/spec.md`. Split when the benefit justifies it. Keep `docs/measurements.md` small per its header's summary/archive rule (#560).
- A split needs a reason in the PR and its own maintainer-approved Issue stating the review mode. Keep it out of unrelated PRs. For CI script changes the cloud exception covers doc-length checks and their tests only. Changing which files CI checks (e.g. invariants) follows independent review (§5) unless the maintainer approves otherwise.
- Keep the original path as index (area, one-line scope, link). Parts are `docs/<kind>/<area>.md` by module (`auth`, `channels`, `messages`, `realtime`) or feature. No per-decision files. New doc kinds need maintainer approval. Never split `AGENTS.md`.
- Pure split: move verbatim. Include an old -> new location table in the PR. Check relative links, heading anchors and file-path references and fix breaks caused by the move. Keep changes to spec guarantees, decisions and invariants out of the split PR and preserve their meaning and scope. Link cross-area rules to their one home where useful.
- Preserve CI checks and budget every resulting file. An invariants split keeps every `path::test_name` and invariant meaning, ensures `web/scripts/check-invariants.ts` checks every part and preserves existence, skip and cargo reconciliation checks. Add multi-file negative tests.
