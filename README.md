# upnext

An **Up next** pane beside the transcript that collects the next steps Claude suggests and shows them as a tree you can act on.

```
✦ Up next                       3 open · 1 done
──────────────────────────────────────────────
▾ ✦ Next steps · turn 4                 2 ▶ ✕
 ├─ ▾ ○ Add unit tests for the parser     ▶ ✕
 │  └─  ✓ cover nested lists               ▶ ✕
 └─   ○ Update the README                 ▶ ✕

▸ ◇ Claude offered · turn 3             2 ▶ ✕
```

The top three open steps also sit in a row above the prompt box:

```
✦ next  1: Add unit tests for the parser  2: Update the README  0: hide
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install upnext --marketplace rseac/upnext
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter).

From a shell:

```
claude plugin install upnext --marketplace rseac/upnext
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `rseac/upnext`, then Add plugin.

This repository is private, so before installing:

1. Ask the owner to invite you as a collaborator on GitHub, and accept the invite.
2. Make sure your machine has a git credential for github.com: an SSH key, or `gh auth login` then `gh auth setup-git`. The install never asks for one.

## Where steps come from

At the end of each turn the mod reads:

- **The reply**: lists under headings or labels like "Next steps", "Suggested follow-ups" or "You could also:". Nested lists become subtrees, and sub-headings become groups.
- **Offers** in the closing lines, like "Want me to add tests or update the README?". Each option becomes its own step.
- **Bash output**: hints like ``Run `npm audit fix` ``, and "Next steps" blocks that scaffolders print.
- **Todo and task lists**: open items from TodoWrite and TaskCreate/TaskUpdate, updated as they change.
- **A guess, when there is nothing else**: if a reply lists no steps, a fork of the session reads the conversation. It either finds the steps the reply implies, or adds a dim **Likely next** group with up to three prompts you'd probably send next. This costs about one short reply. Replies that list their steps cost nothing.

A step can be a slash command, like `/code-review high`. Steps naming a command this session doesn't have are dropped. The model is also told which skills and commands you have, so it can suggest them.

Checked boxes (`- [x]`) arrive already done, and tables of steps are read by their first column.

Each turn adds a new group at the top and folds the older ones away. A step that is already open is not added twice.

## Using it

| Do this | What happens |
| --- | --- |
| Click a step | Puts its prompt in the prompt box as a draft. Edit it, then press Enter. Its sub-steps go along with it. |
| ▶ on a step | Sends it right away. |
| ▶ on a group | Sends every open step in the group as one prompt. |
| ▶▶ on a group | Runs the group in order, one step per turn. It moves on when a step is ✓ and stops at the first that isn't, or when you interrupt. A bar at the top shows progress, with Stop (`s`). |
| + on a group | Adds your own step to that group. |
| ✎ on a step | Edits its text in place. Enter saves; ✕ cancels. |
| ⇶ on a group | Hands each open step (up to five) to its own background agent. Each step shows ⇶ while its agent works, then ✓ or ✗, with a toast. |
| Hover a step | Shows the full prompt it will draft or send (terminal). |
| `1` `2` `3` | From an empty prompt box: drafts that step from the row above the prompt. `0` hides the row until the next turn. |
| Tab | Takes the top new step, shown as dim ghost text in the prompt box. |
| ✕ | Dismisses the step or the group. |
| ▾ / ▸ | Folds or unfolds. |
| The field at the bottom | Adds your own step to a **Your steps** group. |
| Tidy (`t`) | Asks a fork of the session which open steps are already done or no longer relevant, marks or removes them, and says what changed. Costs about one short reply per click. |
| `z` / `c` / `x` | Fold all / clear done / clear all (while the pane has focus). |

Steps found in Bash output are only ever drafted, never sent straight away (their group shows ✎ instead of ▶), since that output can come from anywhere.

The status mark shows progress: ○ open, ◌ queued, ◐ running, ⇶ with a background agent, ✓ done, ✗ not done.

When a step's turn ends, it gets ✓, or ✗ if the reply says it couldn't finish. In `auto` and `model` mode, a fork then checks the work and corrects the mark if needed. Steps also track prompts you type yourself: if what you type clearly matches an open step, that step is marked too.

Open steps are saved per project folder. The next session there brings them back, folded and marked "earlier". The status line shows how many are open.

| Command | What it does |
| --- | --- |
| `/upnext` | Opens the pane. If you closed it, it stays closed until you run this again. |
| `/upnext clear` | Empties the pane and the saved copy. |
| `/upnext export [file]` | Writes every step as a Markdown checklist (default `NEXT_STEPS.md`). |
| `/upnext issues` | Drafts a prompt asking Claude to turn the open steps into GitHub issues, showing them to you first. Nothing is created until you send it and approve. |

### Safety

Step text comes from replies and tool output, which can quote files and web pages. Before a step is shown or sent, the mod removes terminal escape codes and invisible characters, and drops any step that hides text in Unicode tag characters, so a step cannot carry text you cannot see.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `clickAction` | `draft` | `send` makes a click send the step right away; ▶ then becomes ⎘ (draft first). |
| `extractor` | `auto` | `auto`: read replies for free, and ask a fork of the session only when a reply lists nothing, or to check steps you ran. `heuristic`: never call a model. `model`: always ask the fork, which sees the whole conversation and reuses its prompt cache (about one short reply per turn). The pane shows "finding steps…" while it works. |
| `minAnswerChars` | `80` | Replies shorter than this never trigger a model call. |
| `band` | `true` | Shows the top three open steps above the prompt box. |
| `ghostText` | `true` | Offers the top new step as dim text in the prompt box. |
| `statusLine` | `true` | Shows "✦ 3 next steps" in the status line. |
| `keepAcrossSessions` | `true` | Saves open steps per project folder and restores them. |
| `autoOpen` | `true` | Opens the pane when new steps arrive. |
| `scanToolOutput` | `true` | Reads Bash output and todo/task lists too. |
