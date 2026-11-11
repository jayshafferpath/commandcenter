---
description: Read and change the user's Jira tickets through Command Center. Use when the user asks what they're working on, what's blocked or due, for a ticket's details, or to change a ticket's summary, labels, status, or due date.
---

# Command Center: tickets

Use the API base from your briefing (default `http://localhost:3789`).

## Read

- `GET /api/tickets`: the user's open tickets. Every non-Epic issue
  assigned to them that isn't Done, minus their todos (the `Todo` label).
- `GET /api/tickets/:key`: one ticket in full, with its description.

Each ticket in the list carries plain Jira facts, no inferred workflow state:

| Field | Meaning |
|---|---|
| `key`, `summary` | The ticket |
| `statusName` | Jira status, as named in this project's workflow |
| `labels` | Includes `repo:<name>` (which repo dispatch runs in) and lifecycle labels like `ClaudeWork` |
| `issueType`, `isSubtask` | Subtasks get their repo from the parent when they have no `repo:` label |
| `blockedBy`, `blocks` | Keys of linked tickets |
| `dueDate` | `YYYY-MM-DD` or null |
| `activeJobId` | The agent session currently working it, if any (see `/cc-dispatch`) |

"What's blocked" means a non-empty `blockedBy`. "What's due" means sort by
`dueDate`. Tickets without one come last, not first.

## Change

The API has no ticket-edit routes. Use `api/lib/jira.js` from the repo root
in your briefing, through a short Node snippet:

```bash
cd "$REPO_ROOT" && node --input-type=module -e '
import { loadEnv } from "./api/lib/env.js";
import { addLabel, editIssue, transitionForEvent } from "./api/lib/jira.js";
loadEnv();
await addLabel("NEV-1234", "repo:partner-service");
'
```

`loadEnv()` loads the Jira credentials. Without it every call fails on
auth.

| Helper | Use |
|---|---|
| `editIssue(key, update)` | Any field, in Jira's `update` shape, e.g. `{ summary: [{ set: "New title" }] }` or `{ duedate: [{ set: "2026-11-20" }] }` |
| `addLabel` / `removeLabel` / `swapLabel(key, remove, add)` | Labels |
| `transitionForEvent(key, "review" \| "done")` | Move status to the workflow's review or done state |
| `getIssue`, `searchIssues(jql, fields)` | Reads the API doesn't cover |
| `getComments`, `addComment` | Comments (bodies are Atlassian Document Format) |

`transitionForEvent` is best effort. It returns null and leaves the status
alone when the workflow has no matching transition. Check the result and
tell the user if nothing changed, rather than reporting success.

Don't add or remove lifecycle labels (`ClaudeWork`, `ClaudePlanApproved`,
and the like) unless the user asks. Other workflows key off them.
