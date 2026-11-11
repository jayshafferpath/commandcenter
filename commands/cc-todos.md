---
description: List, add, and complete the user's personal todos in Command Center. Use when the user asks what's on their list, says to remind them or add something to do, or says they finished one.
---

# Command Center: todos

Todos are Jira issues carrying the `Todo` label, assigned to the user,
separate from the tickets they work. Use the API base from your briefing
(default `http://localhost:3789`).

## List

`GET /api/todos` returns `{ok, tasks: [{key, summary, dueDate}]}`: every
open todo. Sort by `dueDate` when the user asks what's next. Undated ones
come last.

## Add

```bash
curl -s -X POST "$API/api/todos" -H 'Content-Type: application/json' \
  -d '{"summary": "Renew the cert on the staging proxy", "dueDate": "2026-11-14"}'
```

- `summary` (required): short and specific, the way the user would write it.
- `description` (optional): context they'll want later.
- `dueDate` (optional): `YYYY-MM-DD`. Turn "Friday" or "next week" into a
  real date before sending.

A 400 saying `TODO_PROJECT_KEY is not set` means the user hasn't configured
which Jira project todos go in. Tell them; don't pick a project.

## Complete

`POST /api/todos/:key/complete` moves the todo to its workflow's done state.

It returns `ok: true` even when the workflow has no done-like transition and
nothing changed. When it matters, confirm with `GET /api/todos` that the
todo is gone before telling the user it's done.
