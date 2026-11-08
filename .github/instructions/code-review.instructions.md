---
applyTo: "**"
excludeAgent: "cloud-agent"
---

# Copilot code review — fukulow

You are an additional, advisory reviewer. Another AI reviews risky pull requests separately,
and CI (rustfmt, clippy, tests, OpenAPI diff, web check) already enforces style.

## Prioritise
- The PR description or the linked issue's "Done when" disagrees with the code in this diff.
- Missing organization scoping (`organization_id`), authorization gaps, and real-time events that could reach
  a connection that must not see them.
- Commands, code examples or config that would not run as written.
- Secrets or machine-specific paths in committed files (the repository is public).
- Any other concrete correctness or security problem you are confident about.

## Skip
Anything rustfmt, clippy or CI already enforces; naming or wording that is a matter of taste.

## Format
Only concrete problems. For each: `file:line`, what is wrong, why it matters. English.
