# next-steps-pane

A pane beside the transcript that collects the next steps Claude suggests and shows them as a tree you can act on.

```
✦ Next steps                    3 open · 1 done
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
/plugin install next-steps-pane --marketplace rseac/claude-next-steps-pane
```

Answer `y` to add the marketplace, then pick a scope (user scope is first; press Enter).

From a shell:

```
claude plugin install next-steps-pane --marketplace rseac/claude-next-steps-pane
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `rseac/claude-next-steps-pane`, then Add plugin.

This repository is private, so before installing:

1. Ask the owner to invite you as a collaborator on GitHub, and accept the invite.
2. Make sure your machine has a git credential for github.com: an SSH key, or `gh auth login` then `gh auth setup-git`. The install never asks for one.

## Where steps come from

At the end of each turn the mod reads:

- **The reply**: lists under headings or labels like "Next steps", "Suggested follow-ups" or "You could also:". Nested lists become subtrees, and sub-headings become groups.
- **Offers** in the closing lines, like "Want me to add tests or update the README?". Each option becomes its own step.
- **Bash output**: hints like ``Run `npm audit fix` ``, and "Next steps" blocks that scaffolders print.
- **Todo and task lists**: open items from TodoWrite and TaskCreate/TaskUpdate, updated as they change.

Each turn adds a new group at the top and folds the older ones away. A step that is already open is not added twice.

## Using it

| Do this | What happens |
| --- | --- |
| Click a step | Puts its prompt in the prompt box as a draft. Edit it, then press Enter. Its sub-steps go along with it. |
| ▶ on a step | Sends it right away. |
| ▶ on a group | Sends every open step in the group as one prompt. |
| `1` `2` `3` | From an empty prompt box: drafts that step from the row above the prompt. `0` hides the row until the next turn. |
| Tab | Takes the top new step, shown as dim ghost text in the prompt box. |
| ✕ | Dismisses the step or the group. |
| ▾ / ▸ | Folds or unfolds. |
| `z` / `c` / `x` | Fold all / clear done / clear all (while the pane has focus). |

Steps found in Bash output are only ever drafted, never sent straight away (their group shows ✎ instead of ▶), since that output can come from anywhere.

The status mark shows progress: ○ open, ◌ queued, ◐ running, ✓ done. A step turns ✓ when the turn it started finishes.

`/next-steps` opens the pane. `/next-steps clear` empties it. If you close the pane, it stays closed until you run `/next-steps` again.

### Safety

Step text comes from replies and tool output, which can quote files and web pages. Before a step is shown or sent, the mod removes terminal escape codes and invisible characters, and drops any step that hides text in Unicode tag characters, so a step cannot carry text you cannot see.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `clickAction` | `draft` | `send` makes a click send the step right away; ▶ then becomes ✎ (draft first). |
| `extractor` | `heuristic` | `model` asks a fork of the session to find the steps. The fork sees the whole conversation and reuses its prompt cache, so it costs about one short reply per turn. The pane shows "finding steps…" meanwhile. If the call fails, the heuristic is used. |
| `minAnswerChars` | `80` | With `model`, shorter replies are read by the heuristic alone. |
| `band` | `true` | Shows the top three open steps above the prompt box. |
| `ghostText` | `true` | Offers the top new step as dim text in the prompt box. |
| `autoOpen` | `true` | Opens the pane when new steps arrive. |
| `scanToolOutput` | `true` | Reads Bash output and todo/task lists too. |
