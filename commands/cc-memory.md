---
description: Search and save Pearl's persistent memory in Command Center. Use before answering anything that may depend on earlier context (a past decision, how a ticket turned out, a stated preference), and whenever the user makes a decision or states a preference worth keeping.
---

# Command Center: memory

Notes that survive restarts, stored as Markdown on this machine. Use the API
base from your briefing (default `http://localhost:3789`).

## Recall

```bash
curl -s "$API/api/memory/search?q=why+do+we+avoid+headless+dispatch&limit=5"
```

- `q` (required): ask in plain words. Search matches meaning, so a
  paraphrase finds a note that used different wording.
- `limit`: 1–25, default 5.

Results are ranked: `{title, permalink, content, score, updatedAt}`. Search
returns the note body as `content`. For a long note, fetch it whole with
`GET /api/memory/note?id=<permalink>`.

Search before answering anything that might hinge on the past. Don't
mention the search unless it turned something up.

## Save

```bash
curl -s -X POST "$API/api/memory" -H 'Content-Type: application/json' \
  -d '{"title": "Headless dispatch", "content": "The user prefers interactive mode for dispatched agents: headless runs exit silently on permission prompts."}'
```

Save deliberately. It's memory, not a log.

- **Worth saving:** decisions the user makes and why, their standing
  preferences, outcomes worth knowing later, anything they'd otherwise have
  to re-explain.
- **Not worth saving:** routine status, anything the API can tell you
  fresh (ticket states, job lists), passing remarks.
- **Never save** credentials, tokens, or any patient or member information
  (PHI). Memory is plain files on disk.

Write each note so it makes sense on its own months later: the fact, the
reason, and a date when timing matters. Give it a short, specific title.

### Update instead of duplicating

- A title that already exists returns 409 from `POST /api/memory`. To
  update by title, POST it again with `"overwrite": true`, carrying forward
  whatever in the old note is still true.
- If you already have a note's permalink (from search, list, or a prior
  save), update it directly instead:

  ```bash
  curl -s -X PUT "$API/api/memory/note?id=main/pearl/headless-dispatch" \
    -H 'Content-Type: application/json' \
    -d '{"content": "The user prefers interactive mode for dispatched agents: headless runs exit silently on permission prompts. Confirmed again 2026-11-11."}'
  ```

  Either way, overwrite replaces the whole note — carry forward what's
  still true.
- A save's `similarNotes` lists near-duplicates. When one turns up, merge
  into it instead of keeping both.

Saves and updates take a few seconds and run one at a time.

## List

```bash
curl -s "$API/api/memory/notes?page=1&limit=20"
```

Returns every note's `{title, permalink, updatedAt}`, oldest-API-call-bound
and paginated: `{notes, page, limit, total, hasMore}`. Use it to browse or
to find a permalink when search doesn't turn one up.

## Delete

```bash
curl -s -X DELETE "$API/api/memory/note?id=main/pearl/headless-dispatch"
```

**Confirm with the user before deleting a note** — it can't be undone.
Deleting an unknown permalink returns 404.

## Errors

- 503 means memory isn't installed (`./install.sh --memory`). Carry on
  without it, and mention it once if the user asked you to remember something.
- 502 means the memory tool failed. The `error` says how.
- 404 on update or delete means that permalink doesn't exist — double-check
  it with search or list.
