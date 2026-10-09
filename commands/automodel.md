---
description: Pick the model that fits the task actually in front of you, then switch to it before doing anything else.
allowed-tools:
  - Skill
---

# Automodel

Run this first, before acting on anything else in this message. Everything
after this skill's own instructions — a ticket's context block, a free-form
task description, whatever follows — is the thing you're sizing up, not
something to act on yet.

## Step 1: Read the signal already in front of you

Look at what's actually in this message:

- A `Labels:` line containing `complexity:trivial` — the human already
  made this call. Don't second-guess it.
- A `Description:` block — its length and shape are the strongest signal
  when there's no complexity label. A few sentences describing a concrete,
  bounded change reads differently than multiple paragraphs of acceptance
  criteria, open implementation decisions, or words like "spike",
  "investigate", "design", "architecture", "decide between".
- No ticket context at all (a general dispatch, or Pearl's own briefing) —
  judge the task description on the same terms: a quick lookup/edit vs. an
  open-ended or multi-step request.

## Step 2: Pick one

- **haiku** — `complexity:trivial` is set, or the task is a small, mechanical,
  unambiguous change with no real judgment calls (a rename, a doc tweak, a
  one-line fix).
- **opus** — the description is long/multi-part, names open decisions still
  to be made, spans multiple files or systems, or is explicitly a spike,
  investigation, or architectural question. Also use this when you're
  genuinely unsure which bucket a non-trivial task falls into — the more
  capable model is the safer default under uncertainty, not sonnet.
- **sonnet** — everything else: a normal, bounded, well-specified piece of
  work. This is the default when nothing above points elsewhere.

## Step 3: Switch, then proceed

Run `/model <your-pick>` (e.g. `/model opus`). Then continue on to the rest
of this message as the actual task — don't stop after switching, and don't
mention this skill or the model choice in your eventual response unless
something about it is actually worth flagging (e.g. you want to tell the
human you're using opus because the scope is genuinely unclear).
