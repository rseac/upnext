# next-steps-pane

A pane beside the transcript that collects the next steps Claude suggests and shows them as a tree you can act on.

```
✦ Next steps                    3 open · 1 done
──────────────────────────────────────────────
▾ ✦ Next steps · turn 4                 2 ▶ ✕
 ├─ ▾ ○ Add unit tests for the parser     ✎ ✕
 │  └─  ✓ cover nested lists               ✎ ✕
 └─   ○ Update the README                 ✎ ✕

▸ ◇ Claude offered · turn 3             2 ▶ ✕
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

This repository is private: it installs only for people who can read it on GitHub and whose machine already holds a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

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
| Click a step | Sends it as your next prompt. Its sub-steps go along with it. |
| ▶ on a group | Sends every open step in the group as one prompt. |
| ✎ | Puts the prompt in the prompt box so you can edit it first. |
| ✕ | Dismisses the step or the group. |
| ▾ / ▸ | Folds or unfolds. |
| `z` / `c` / `x` | Fold all / clear done / clear all (while the pane has focus). |

The status mark shows progress: ○ open, ◌ queued, ◐ running, ✓ done. A step turns ✓ when the turn it started finishes.

`/next-steps` opens the pane. `/next-steps clear` empties it. If you close the pane, it stays closed until you run `/next-steps` again.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `extractor` | `heuristic` | `model` asks Haiku to find the steps instead. It is smarter on free-form replies, but costs one small call per turn. If the call fails, the heuristic is used. |
| `autoOpen` | `true` | Opens the pane when new steps arrive. |
| `scanToolOutput` | `true` | Reads Bash output and todo/task lists too. |
