# Issue tracker: GitHub

Issues and specifications for this repository live in GitHub Issues at amrtawfik160/bb-dev-browser-plugin. Use the gh CLI for all operations.

## Conventions

- **Create an issue**: gh issue create --title "..." --body "...". Use a heredoc for multi-line bodies.
- **Read an issue**: gh issue view <number> --json number,title,body,state,labels,comments --jq '{number,title,body,state,labels:[.labels[].name],comments:[.comments[].body]}'.
- **List issues**: gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number,title,body,labels:[.labels[].name],comments:[.comments[].body]}]' with appropriate label filters.
- **Comment on an issue**: gh issue comment <number> --body "..."
- **Apply or remove labels**: gh issue edit <number> --add-label "..." or gh issue edit <number> --remove-label "..."
- **Close an issue**: gh issue close <number> --comment "..."

Infer the repository from the GitHub remote; gh does this automatically when run inside this clone.

## Pull requests as a triage surface

**PRs as a request surface: no.** Set this to yes only if the repository later treats external pull requests as feature requests.

When set to yes, pull requests run through the same labels and states as issues, using the gh pr equivalents:

- **Read a pull request**: gh pr view <number> --comments and gh pr diff <number>.
- **List external pull requests for triage**: gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments, then keep only CONTRIBUTOR, FIRST_TIME_CONTRIBUTOR, or NONE author associations.
- **Comment, label, or close**: use gh pr comment, gh pr edit --add-label or --remove-label, and gh pr close.

GitHub shares one number space across issues and pull requests. Resolve an ambiguous number with gh pr view <number> and fall back to gh issue view <number>.

## When a skill says “publish to the issue tracker”

Create a GitHub issue.

## When a skill says “fetch the relevant ticket”

Run gh issue view <number> --comments.

## Wayfinding operations

The map is a single issue with child issues as tickets.

- **Map**: create one issue labelled wayfinder:map, containing Notes, Decisions-so-far, and Fog.
- **Child ticket**: link an issue to the map as a GitHub sub-issue. If sub-issues are unavailable, add it to a task list in the map and put Part of #<map> at the start of the child body. Apply a wayfinder:<type> label for research, prototype, grilling, or task.
- **Blocking**: use GitHub's native issue dependencies. Add an edge with gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-database-id>, where the database ID comes from gh api repos/<owner>/<repo>/issues/<number> --jq .id. If dependencies are unavailable, use a Blocked by: #<number> line in the child body.
- **Frontier**: scan the map's open children, discard assigned issues and issues with open blockers, and choose the first remaining child in map order.
- **Claim**: run gh issue edit <number> --add-assignee @me as the session's first write.
- **Resolve**: comment with the answer, close the issue, and append a concise context pointer to the map's Decisions-so-far.
