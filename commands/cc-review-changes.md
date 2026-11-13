---
description: Work through Jay's comments from a closed review round, make the changes, commit once, and open the next round. Use when you were dispatched with review context to address a review-loop round's comments.
---

# Command Center: review changes

You're the change agent for one round of an interactive review loop. Your
prompt names the review id and round, and you're running in the review's
repo. Use the API base from your briefing (default `http://localhost:3789`).

## Load the comments

```bash
curl -s "$API/api/review/$ID"                # session: repo, currentRound, rootBaseSha
curl -s "$API/api/review/$ID/round/$N"       # round N: chunks and comments
```

Work every comment with `status: "open"` from round N. Each has `file`,
`line`, and `text`: what Jay wants, in his words. Before changing anything,
read the comment's file around its line, and skim the whole feature
(`git log <rootBaseSha>..HEAD`, `git diff <rootBaseSha>..HEAD`) so a fix
fits the branch, not just the one line.

## One comment at a time

**If you agree**, make the change, then record it:

```bash
curl -s -X POST "$API/api/review/$ID/comments/<commentId>/resolution" \
  -H 'Content-Type: application/json' \
  -d '{"status": "resolved", "note": "<what you changed, one or two sentences>", "files": ["src/path/one.ts"]}'
```

`files` lists every repo-relative path you touched for this comment,
exactly as git reports them. The next round uses it to match each changed
file back to the comment that caused it. A file you change that no
resolution names shows up there as "not tied to a comment."

**If you disagree, stop and ask Jay. Never decline a comment on your
own.** Bring your terminal to the front and tell him out loud:

```bash
curl -s -X POST "$API/api/jobs/<your job id>/open-terminal"
curl -s -X POST "$API/api/voice/<your job id>/speak" -H 'Content-Type: application/json' \
  -d '{"text": "I need your call on a review comment."}'
```

Your job id is at the end of your prompt. Then lay out the comment, what
you'd do instead, and why, in a few sentences, and wait. He'll tell you to:

- **Do it anyway**: make the change and record it `resolved`.
- **Push back**: record `pushed_back`, with a note giving the reasoning he
  agreed to and `files: []`.
- **Something else**: do what he says, then record whichever status fits.

Stay in scope. Change only what the comments ask for. No opportunistic
refactors, no "while I was in here" cleanups. If you spot something worth
fixing that no comment asks for, mention it in your report instead.

## Verify, commit once, open the next round

When every comment from round N is resolved or pushed back:

1. Run the repo's own verification, as its `CLAUDE.md` defines it (tests,
   lint, build). Fix what your changes broke. If something fails that your
   changes didn't cause, say so in your report rather than fixing it.
2. Make **one** local commit for the round:
   ```
   Review round N: address comments

   cm_…: <one line on what changed>
   cm_…: pushed back, <one line on why>
   ```
   Skip the commit if every comment was pushed back and nothing changed.
   Never push. Never amend. Never skip hooks; if one fails, fix the cause
   and make a new commit.
3. Open the next round:
   ```bash
   curl -s -X POST "$API/api/review/$ID/round/$N/next"
   ```
   It refuses while any round N comment is still open, or while the working
   tree has uncommitted changes. The response lists what's wrong. Calling it
   twice is safe.
4. Say "Round N+1 is ready" out loud through the voice route, then report
   to the supervisor (`/cc-report`): how many comments you resolved and
   pushed back, the commit sha, and anything you noticed but left alone.
