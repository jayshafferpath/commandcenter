# The interactive review loop

Code review, but live: instead of leaving comments on a PR and waiting,
you walk the diff with an agent in real time, talk through each piece out
loud (or in text), and another agent goes and makes the changes before
you look at the next round — all in one sitting instead of an
async back-and-forth over hours or days.

A review is one continuous conversation made of **rounds**. Each round
has two phases: you look at the diff (**walkthrough**), then an agent
acts on what you said (**changes**). A round with nothing to change ends
the review.

## How it goes, step by step

```
 1. START A REVIEW
    Ask the supervisor agent ("Pearl") to review a branch, or call
    POST /api/review/start with the repo + base branch.
    → Round 1's diff is computed. Nothing is "in progress" yet.
                      |
                      v
 2. WALKTHROUGH BEGINS
    Pearl dispatches an interactive walkthrough agent for the round.
    → The round is now actively being walked.
                      |
                      v
 3. GROUPING
    The walkthrough agent groups the round's changed files by logic
    and data flow (not file order) and shows you the plan.
                      |
                      v
 4. ELEMENT BY ELEMENT
    For each group, for each chunk, for each element inside it
    (a function, a class, a logical section):
      - VS Code jumps to that element's diff
      - the agent explains it in a sentence or two
      - you react
         - say nothing changed-needed  -> checklist item confirmed, move on
         - leave a comment             -> comment recorded, agent STAYS
                                           on this element until you
                                           explicitly say to move on
      (repeat until every element in every chunk is covered)
                      |
                      v
 5. YOU CLOSE THE ROUND
    You say something like "that's it for now" / "I'm good with this."
    → The round's comment-taking phase ends.
                      |
          ,-----------+-----------.
          |                       |
   no comments this round    one or more comments
          |                       |
          v                       v
    REVIEW APPROVED          AGENT WORKS THE COMMENTS
    (done — nothing              - agrees -> makes the change,
     further happens)              records it, moves on
                                  - disagrees -> stops and asks you
                                    directly, never decides alone
                                  (one comment at a time, until the
                                   round's comments are all resolved
                                   or pushed back)
                      |
                      v
 6. ONE COMMIT, NEXT ROUND
    The change agent makes exactly one commit for the whole round
    (or none, if everything was pushed back with no code change),
    then opens round N+1 as the diff since this round's commit.
                      |
                      v
          back to step 2, for the new round
```

Rounds keep repeating — walkthrough, your comments, one commit, next
round — until a round closes with nothing to say. That's what "approved"
means here: not a single sign-off, but the moment a round produces zero
comments.

## Leaving a comment mid-walkthrough

A comment doesn't end the conversation about that element — the agent
stays there, acknowledges what it captured, and waits for you to
explicitly say to move on ("next", "looks good", anything that plainly
means continue). You can also ask it to go back to an earlier element or
chunk at any point; nothing is locked once you've passed it within a
round.

## If the change agent disagrees with you

It never quietly declines a comment. It stops, brings its terminal
forward, and talks to you directly about why, then does whichever of
these you tell it:

- make the change anyway
- leave the code as is (recorded as "pushed back," with the reasoning
  you agreed to)
- something else entirely

## Abandoning a review

Say so, and the review is dropped — legal at any point except after it's
already been approved or already abandoned. Any walkthrough or change
agent still actively working that review gets shut down with it, so
nothing keeps grinding on work you've dropped.

## States at a glance

| State | What's actually happening |
|---|---|
| `round_ready` | A round's diff exists; nobody is walking it yet. |
| `walkthrough_in_progress` | You're going element by element with the walkthrough agent. |
| `awaiting_change_job` | You closed the round with comments; no change agent has started yet. |
| `changes_in_progress` | A change agent is working through this round's comments. |
| `approved` | A round closed with zero comments. The review is done. |
| `abandoned` | Dropped before approval. |

Only `approved` and `abandoned` are end states — every other state leads
to another round.
