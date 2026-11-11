---
description: Report back to Pearl, Command Center's supervisor agent, when a dispatched task ends. Use when you were dispatched by Command Center and you've finished, failed, or are stopping because you're blocked.
---

# Command Center: reporting back to Pearl

Pearl doesn't poll for results. Your message is how she learns how the task
went, and she relays it to the user. Your prompt names her (usually `Pearl`).

## When

Send exactly one report, when the task ends, whichever way it ends:

- **Done**: the work is finished.
- **Failed**: you tried and couldn't, and you're not going to keep trying.
- **Blocked**: you need a decision, access, or information only a human
  can give.

Don't send progress updates along the way, and don't wait for a reply
after you send.

## How

```
SendMessage({ to: "Pearl", message: "..." })
```

Use the name your prompt gives, if it's not `Pearl`.

## What to say

One or two sentences: what happened, and whether anything needs the user's
attention. Make the first sentence stand on its own. Pearl may relay it
as-is.

- Done: "NEV-1234 is done: PR #482 drops the insurance section, tests pass.
  Nothing needs the user."
- Blocked: "NEV-1234 is blocked: the partner sandbox rejects our API key.
  The user needs to request a new one."
- Failed: "Couldn't reproduce the timeout locally after three approaches.
  Needs the user to decide whether to pull production logs."

Lead with the ticket key when there is one. Name any PR, branch, or file the user
would need to look at.
