# Issue tracker: GitHub

Issues and PRDs for this repository live as GitHub issues in `ttropolis/fablepeak`. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`
- **Read an issue**: `gh issue view <number> --comments`, including its labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments`
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`
- **Close an issue**: `gh issue close <number> --comment "..."`

Infer the repository from `git remote -v`; `gh` does this automatically inside the clone.

## Pull requests as a triage surface

**PRs as a request surface: no.**

If changed to `yes`, external PRs use the same labels and states as issues:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>`
- **List external PRs**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`
- **Comment, label, or close**: use `gh pr comment`, `gh pr edit`, or `gh pr close`

GitHub shares one number space across issues and pull requests. Resolve an ambiguous `#42` with `gh pr view 42`, falling back to `gh issue view 42`.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The map is one issue with child issues as tickets.

- **Map**: an issue labelled `wayfinder:map` containing Notes, Decisions-so-far, and Fog.
- **Child ticket**: a GitHub sub-issue. If sub-issues are unavailable, link it from a task list and add `Part of #<map>` to the child.
- **Child labels**: `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, or `wayfinder:task`.
- **Blocking**: use GitHub native issue dependencies. If unavailable, add `Blocked by: #<n>` to the child.
- **Frontier query**: select the first open, unassigned child without open blockers.
- **Claim**: `gh issue edit <n> --add-assignee @me`
- **Resolve**: comment with the answer, close the child, and append its context pointer to the map’s Decisions-so-far.
