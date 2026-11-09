# Workflow (operating procedure for AIs)

Follow this without waiting for a human prompt. Rules: `AGENTS.md`. Rationale: `docs/decisions.md`.
Run commands for GitHub as your own identity: `/Users/tomoya/.fukulow-ai/run-as.sh <claude|codex|antigravity> <command>` (`< /dev/null`), e.g. `... gh pr list`, `... git push -q origin HEAD:<branch>`.
Never push to `main`. Never merge unless the maintainer explicitly says so.

## 1. Sweep (run at every wake-up, notification, user message, or finished AI run)
1. `gh pr list --state open --json number,title,labels,headRefOid,mergeable,statusCheckRollup` and `gh issue list --state open --json number,title,labels,milestone`.
2. For each item, find its row in section 2 and do the "Next action" if an AI can do it. Then re-list; repeat until nothing AI-doable is left.
3. Fix labels: at most one `status:*` label per item; an open item with none gets the one that matches its state; green + reviews done never stays unlabelled.
4. Check for stalls (section 7): an AI run that ended without updating label/comment, stale CI, `blocked` whose blocker is merged.
5. Stop only when every remaining item is waiting for a human (`status:human-review` / `status:needs-decision`, question in the last comment). Then report the list to the user.

## 2. State -> next action
| Item, label | Who acts | Next action | Step ends when |
|---|---|---|---|
| Issue, none | author AI | Add "Done when", milestone; feature: "How I read the spec" (3-5 lines, spec terms). Decide the review path (section 3) | label set to `status:ai-review` or `status:human-review` |
| Issue, `status:ai-review` | an AI that did not write it | Review (section 5), comment, max 2 rounds | verdict commented; label `status:human-review` (or `status:needs-decision`) |
| Issue, `status:human-review` | maintainer | none for AI. Do other work | maintainer comments "OK" |
| Issue, "OK" comment present | any AI | Set `status:ready` | label is `status:ready` |
| Issue, `status:ready` | implementer by area (section 4) | Set `status:working`, branch, worktree, implement, open draft PR | PR open, Issue linked (`Closes #n`) |
| PR draft/open, `status:working` | implementer | Run Commands from `AGENTS.md`; push; wait for CI with `gh pr checks <n> --watch` | CI green and PR marked ready -> `status:ai-review` |
| PR, `status:ai-review`, CI red | implementer (or sweeper) | Read the failing job tail (`gh run view <id> --log-failed`); fix; transient failure: section 7 | CI green |
| PR, `status:ai-review`, CI green | sweeper | Required AI review not done: launch it (section 5). Copilot due and not yet requested: request once. Findings: implementer fixes | all required reviews finished -> `status:human-review` |
| PR, `status:human-review` | maintainer | Nothing for AI unless the maintainer asks for changes -> `status:working` | maintainer merges or comments |
| Issue/PR, `status:needs-decision` | maintainer | none for AI; keep working on other items | maintainer answers; AI then removes the label and continues |
| Issue/PR, `blocked` | whoever merges/closes the blocker | After the blocker merges, remove `blocked`, set the next status, comment | label removed |
| PR conflicting with main | implementer | Section 6 | CI green on the merge commit |
| Dependency update PR | any AI | Section 8 | `status:human-review` |
| PR merged | sweeper | Verify Issue closed; remove status labels; unblock dependents; delete worktree/branch | nothing left open for it |

## 3. Issue review path
- Maintainer approval is always needed for: any new feature or behaviour change (even if described in `docs/spec.md`); auth, permissions, real-time, migrations; API or schema contract changes;
  new dependencies or languages; cost, deploy, secrets. Order: AI review (`status:ai-review`) -> `status:human-review` -> "OK" -> `status:ready`.
- AI review of an Issue is required for `risk:needs-review` and large Issues; for small ones the author may skip it: go straight to `status:human-review` and record the decision and reason in the Issue.
- An AI decides alone only for: bug fixes with a clear repro, refactors without behaviour change, tests, CI, docs, patch updates. Set `status:ready` itself.
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
- Antigravity: `agy` (argon, `/usr/local/argon-agy/agy`) only until a new model ships; effort is the `--model` suffix `claude-sonnet-5-5-low|medium|high`, fixed at launch:
  low = small copy, limit or type fixes; medium = new screens or state modules, vitest additions, conflict and CI fixes, browser checks; high = browser-side real-time, auth-screen session handling, new E2E suites, multi-screen state design.
  If harder than expected: stop, report, restart higher.
- Claude: Sonnet by default; Opus only for round 1 of high-risk review or heavy implementation.
- Launch every AI under its own identity via `run-as.sh <name> <cli ...>`; Codex effort via `model_reasoning_effort`. Put the model and effort in the signature line.
- Exceptions to the area table need a line in the Issue (e.g. Codex implements the sync protocol/controller, H3 high; adapter and components stay with Antigravity).

## 5. Reviews
- AI review of an Issue or PR is at most 2 rounds in total per item; changing the reviewing AI does not reset it. Round 2 checks only changes and how earlier findings were addressed.
- Non-blocking findings become follow-up Issues, not another round. Blocking findings unresolved after round 2 -> `status:needs-decision`.
- PRs touching auth, permissions, real-time or migrations are reviewed by an AI that did not write them. AI-authored by astra: same.
- Copilot auto-review is OFF (credits). Request once per PR, by hand, when CI is green and the work is done: `gh pr edit <n> --add-reviewer @copilot`. Only for `risk:needs-review` or large code PRs. Re-request only if the maintainer asks.
- `status:human-review` only after the Copilot review (if requested) has finished.
- Every Issue comment, review and PR body ends with `AI: <name> / model: <id> / effort: <level>`. Everything on GitHub is in English.

## 6. Conflicts and CI
- Conflict: in the PR worktree `git fetch origin && git merge origin/main`; resolve; run Commands; push. `docs/decisions.md` conflicts: keep both sides, append-only, never rewrite others' lines.
- CI does not start after a conflict-resolving merge push: push an empty commit (`git commit --allow-empty -m "Trigger CI"`). If `gh run rerun` is denied, do not work around it; ask the maintainer.
- A green check on a conflicting PR is stale: resolve the conflict first, then trust only CI on the new head.

## 7. Stalls
| Symptom | Action |
|---|---|
| CI not started after merge push | empty commit (section 6) |
| Green CI is for an older sha than PR head | wait for/trigger CI on the head; never treat as green |
| Transient CI failure (network, runner, flaky) | rerun the failed job once; if rerun is denied, push an empty commit; a second failure is a real failure |
| AI run ended without label/comment update | sweeper reads the PR/branch, finishes the label and writes the comment with the next step |
| Dependent Issue waits on a PR | label it `blocked`, comment "blocked by #n"; the AI that merges/closes #n removes it |
| Results arrive while orchestrator idle | run the sweep at once, do not wait for the next user message |
| An AI is stuck or needs higher effort | stop it, comment findings, restart at the next effort (section 4) |
| Needs a token, secret or denied permission | `status:needs-decision` with the exact request; continue other items |

## 8. Dependency updates and versions
- Dependabot (weekly, grouped) opens PRs for Cargo, npm, GitHub Actions, Docker. Pin exact patch versions; Rust = `rust-toolchain.toml`, Node = `.node-version` and `web/package.json` `engines`.
- An AI reads the changelog for breaking changes, runs Commands, comments the result, then sets `status:human-review` (asks the maintainer to merge).
- Rust toolchain bump: also re-verify the module-direction checker (`rustc_private`); a bump that breaks it is not merged until the checker is updated. k6 (`K6_IMAGE` in Makefile) is bumped by hand.
- Security updates are a GitHub setting (Dependabot alerts/security updates); do not claim they work until a security PR is seen.

## 9. Parallel orchestration
- One worktree per AI and branch (`/private/tmp/<topic>`, from `origin/main`). No two writers on the same files; split work by module or file set, else serialise.
- Before launching, list files each task touches; overlapping tasks run one after another. Rebase/merge `origin/main` before marking ready.
- Launch background runs and keep the sweep going; collect results as they arrive (section 1).
- Before an AI finishes it must record: the status label for the next actor, and a comment with what was done, CI state, and the next step with who does it.

## 10. Merge (only when the maintainer explicitly says so)
1. `gh pr view <n> --json headRefOid,mergeable,statusCheckRollup,isDraft`; the head sha equals the sha CI ran on; all checks pass; `mergeable` is `MERGEABLE`; not draft; required reviews finished.
2. `gh pr merge <n> --squash`; confirm the Issue closed; remove labels; delete branch and worktree; unblock dependents.

## 11. Labels and milestones
- Status: `status:working`, `status:ai-review`, `status:human-review`, `status:ready`, `status:needs-decision`. Filter: `label:status:human-review`.
- Others: `security` (red), `bug` (orange), `risk:needs-review`, `blocked`. Urgent = `security`/`bug` + `status:human-review`/`status:needs-decision`. No area/type/ai labels.
- Milestone = one-week sprint (at most 2 open); every Issue gets one. Modules are expressed with labels, not milestones.

## 12. Needs the maintainer
Merges; Issue approvals ("OK"); token/secret changes; adding a language, dependency or cost; deploy; anything in the AI prohibited list; denied permissions. Everything else proceeds without asking.
