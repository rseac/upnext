# upnext

An **Up next** pane beside the transcript that collects the next steps Claude suggests and shows them as a tree you can act on.

```
✦ Up next                               5 open · 1 done
───────────────────────────────────────────────────────
▾ ● Auth · turn 9                 3 ✎ + ▶▶ ⇶ ▶ ✕
 ├─ ○ Move token check into middleware   ▶ ✎ ✕
 ├─ ○ Add expiry tests •                 ▶ ✎ ✕
 └─ ✓ Remove the old session table       ▶ ✎ ✕

▾ ● Docs · turn 8                 2 ✎ + ▶▶ ⇶ ▶ ✕
 ├─ ○ Document the new flags             ▶ ✎ ✕
 └─ ○ Fix broken links in README         ▶ ✎ ✕

▸ ☐ Todo list                                  1 ✕
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

## Streams

Each line of work gets its own **stream** (●), kept across turns:

- **Sorting:** new steps from a reply join the stream they belong to. A matching heading ("Docs follow-ups" → **Docs**) or enough shared words decide it. When a fork is reading the reply anyway, it picks the stream by name.
- **New streams:** a group about something new starts its own stream, named after its heading or first step.
- **Within a stream:** a step that is close enough to one already there is not added again. Steps new this turn get a small •.
- **Order:** streams that got steps move to the top. The others stay where they are and keep their own folding.
- **Fixing it up:**
  - ✎ on a stream renames it, and offers **merge into → another stream**.
  - ✎ on a step offers **move to → another stream** or **→ new stream**.
- **Above the prompt:** the 1/2/3 row shows the top step of each stream first.
- **Not streams:** Bash hints, the todo list and "Likely next" guesses stay as their own groups.
- **Colours:** each stream gets its own colour, picked so neighbours differ. The 1/2/3 row marks each step with its stream's colour.
- **Archive (⊟):** parks a stream. It leaves the tree, the 1/2/3 row and the count, and waits under **Archived** at the bottom of the pane until you press **restore**. If a reply picks the topic up again, the stream comes back by itself.
- **One stream only (◎):** shows just that stream. **Show all** (`a`) brings the rest back. `/upnext <name>` does the same from the prompt.
- **Nudges:** a stream with open steps and no activity for 10 turns gets one toast, so it isn't forgotten. Change or turn off with `nudgeAfter`.

▶▶ and ⇶ work per stream. Only one stream can run in order at a time, since it uses the main conversation, but background agents can work on other streams meanwhile.

## Inside herdr

When Claude Code runs inside [herdr](https://herdr.dev), Up next draws its tree in a herdr pane of its own, to the right of Claude's, instead of inside Claude. It uses plain characters, so it lines up however the terminal counts symbol widths.

```
┌─ claude ───────────────────┬─ upnext ─────────────────────┐
│ transcript…                │ ✦ Up next             3 open │
│                            │ ▾ ● Auth  2           ▶ ⊟ ✕  │
│                            │ ├─ ○ Rotate the key     ▶ ✕  │
│                            │ └─ ◐ Audit the store    ▶ ✕  │
│ > _                        │ ▾ ● Docs  1           ▶ ⊟ ✕  │
└────────────────────────────┴──────────────────────────────┘
```

| Mouse | Keys | What it does |
| --- | --- | --- |
| Click a step | Enter or `d` | Drafts it in Claude's prompt box and moves you to Claude's pane |
| ▶ | `s` | Sends the step (on a stream: all its open steps) |
| ✕ | `x` | Dismisses the step or stream |
| ⊟ | `a` | Archives the stream |
| Click a stream's name | Space | Folds or unfolds it |
| Wheel | `j` `k` ↓ ↑ `g` `G` | Scrolls / moves |
| | `q` | Closes the viewer |

Colours carry meaning:

- **Each stream's colour** runs through its name and tree lines, so you can tell which stream a step is in while scrolling.
- **Step text** shows its state: normal when open, yellow while running, red when ✗, dim green and struck through when done.
- **Bold with a •** marks a step that is new this turn.
- **Blue** marks `code` and slash commands, the parts that will actually run.
- **A grey name with "idle"** marks a stream untouched for `nudgeAfter` turns.
- **The header** counts open, running and ✗ steps.
- **▶ ⊟ ✕** stay grey until the mouse is on their row, then turn green, yellow and red.

The row under the mouse lights up. Every symbol is one herdr draws one cell wide; set `herdrGlyphs` to `ascii` if your font draws any of them badly.

- **When it opens:** when the first steps arrive. If you close it, it stays closed until `/upnext herdr`.
- **The count:** Claude's herdr pane gets the title "3 next" while steps are open (`herdrLabel`).
- **The pane inside Claude still works:** `/upnext` opens it as before.
- **Outside herdr** nothing changes.
- **Requires** `python3`. The viewer only reads a state file in `~/.claude/upnext/herdr/` and leaves its requests in a second file there. The mod picks them up twice a second and acts on them the same way the pane's buttons do.

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

**Ticked off for you:** after a `git commit`, open steps the commit message clearly covers get ✓. After a test run that passes, steps like "fix the failing test" or "run the tests" get ✓. A toast says what was ticked. Turn this off with `autoTick`.

The status mark shows progress: ○ open, ◌ queued, ◐ running, ⇶ with a background agent, ✓ done, ✗ not done.

When a step's turn ends, it gets ✓, or ✗ if the reply says it couldn't finish. In `auto` and `model` mode, a fork then checks the work and corrects the mark if needed. Steps also track prompts you type yourself: if what you type clearly matches an open step, that step is marked too.

Open steps are saved per project folder. The next session there brings them back, folded and marked "earlier". The status line shows how many are open.

**After `/clear`, or in a new session**, steps from before are folded and marked "earlier". The pane shows them exactly as before, but clicking one builds a prompt that stands on its own: the step itself instead of "Yes, please…", the stream it belongs to, and a note to check the code first, since some of it may be done. That wording is put together when you click and never stored. `/clear` also puts queued and running steps back to open and stops a run in order. Background agents (⇶) are left to finish.

**When the context fills and Claude Code compacts it**, the conversation goes on as a summary. Up next adds its newest 15 open steps to the summarizer's instructions, so the summary keeps what they refer to (files, functions, decisions) and their prompts still make sense. Nothing in the pane changes. Steps past those 15 are marked "earlier" once the compaction is done, so they get the self-contained prompt.

| Command | What it does |
| --- | --- |
| `/upnext` | Opens the pane. If you closed it, it stays closed until you run this again. |
| `/upnext <stream>` | Shows only the stream whose name matches (exact, then starts with, then contains). Restores it if archived. |
| `/upnext all` | Shows every stream again. |
| `/upnext herdr` | Opens the herdr viewer pane (inside herdr only). |
| `/upnext clear` | Empties the pane and the saved copy. |
| `/upnext export [file]` | Writes every step as a Markdown checklist (default `NEXT_STEPS.md`). |
| `/upnext issues` | Drafts a prompt asking Claude to turn the open steps into GitHub issues, showing them to you first. Nothing is created until you send it and approve. |

### Safety

Step text comes from replies and tool output, which can quote files and web pages. Before a step is shown or sent, the mod removes terminal escape codes and invisible characters, and drops any step that hides text in Unicode tag characters, so a step cannot carry text you cannot see.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `clickAction` | `draft` | `send` makes a click send the step right away; ▶ then becomes ✐ (draft first). |
| `extractor` | `auto` | `auto`: read replies for free, and ask a fork of the session only when a reply lists nothing, or to check steps you ran. `heuristic`: never call a model. `model`: always ask the fork, which sees the whole conversation and reuses its prompt cache (about one short reply per turn). The pane shows "finding steps…" while it works. |
| `minAnswerChars` | `80` | Replies shorter than this never trigger a model call. |
| `nudgeAfter` | `10` | Turns a stream can sit idle with open steps before one toast says so. `0` turns nudges off. |
| `band` | `true` | Shows the top three open steps above the prompt box. |
| `ghostText` | `true` | Offers the top new step as dim text in the prompt box. |
| `statusLine` | `true` | Shows "✦ 3 next steps" in the status line. |
| `keepAcrossSessions` | `true` | Saves open steps per project folder and restores them. |
| `autoOpen` | `true` | Opens the pane when new steps arrive. |
| `scanToolOutput` | `true` | Reads Bash output and todo/task lists too. |
| `autoTick` | `true` | Ticks steps off after a commit that covers them, or a test run that passes. |
| `paneStyle` | `auto` | `auto`: inside herdr, draw the tree in a herdr pane; elsewhere, the pane inside Claude. `claude`: always the pane inside Claude (`/upnext herdr` still works). |
| `herdrLabel` | `true` | Inside herdr, shows the open count as the title of Claude's pane. |
| `herdrGlyphs` | `symbols` | `ascii` draws the herdr pane with plain characters. |

## License

MIT. See [LICENSE](LICENSE).
