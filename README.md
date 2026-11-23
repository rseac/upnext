<p align="center">
  <img src=".claude-plugin/icon.png" alt="upnext" width="180">
</p>

<h1 align="center">upnext — Plan-Coordinated Next Steps, Task Queue & Session Handoff for Claude Code</h1>

<p align="center">
  <strong>A Claude Code plugin that consolidates your active plan with the next steps Claude suggests—surfacing the current frontier right above your prompt box, in a Plan pane (<code>p</code>), or across background agents.</strong>
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#how-it-looks">Screenshots</a> ·
  <a href="#how-it-works">How It Works</a> ·
  <a href="#commands--shortcuts">Commands & Keys</a> ·
  <a href="#session-handoff-pr-summaries--github-issues">Handoff & GitHub Issues</a> ·
  <a href="#inside-herdr">herdr Popup</a> ·
  <a href="#options">Options</a>
</p>

## Why upnext?

Most Claude Code sessions combine a broader plan with tactical follow-up suggestions at the end of each reply ("Next steps", "Want me to also…"). Without coordination they go wrong in predictable ways:

- **Tactical suggestions drift from the plan** or duplicate steps that are already on your roadmap.
- **Earlier steps scroll away** as new replies bury them.
- **You lose track of what matters now** when switching between several lines of work or when 10+ plan steps are open at once.
- **Acting on a step means retyping** or copy-pasting back into the prompt box.
- **Completed work disappears** without an audit trail you can review after the fact.

## What upnext does

- **Consolidates plans and LLM suggestions into one spine:** automatically tracks plans from Plan Mode (`ExitPlanMode`, `~/.claude/plans/*.md`) and repo plan files (`PLAN.md`, `NEXT_STEPS.md`, `TODO.md`, `docs/*plan*.md`). When Claude's reply suggests next steps, `upnext` merges refinements into matching plan steps and nests tactical actions as `+N` sub-steps under the plan item they serve instead of creating duplicates.
- **Surfaces the active frontier (`1` `2` `3`) & full Plan pane (`p`):** promotes the first 1–2 uncompleted steps in your plan (plus immediate blockers) above the prompt box while later plan steps wait their turn. Press `p` from an empty prompt box (or run `/upnext plan [file]`) to open the **Plan view** with all completed (`✓`) and remaining (`○`) plan steps in order.
- **Drafts or runs on `1` `2` `3` (hotkey or typed):** pressing `1`/`2`/`3` from an empty prompt box—or typing `"1"`, `"do 2"`, `"1 and 3"`, `"the first one"`, `"do both"`, `"yes"`—expands and runs the actual step prompt (including `☐` check steps, never silently deleting them).
- **Verifies completion & keeps a reviewable log:** auto-ticks steps from paraphrased prompts (via Haiku reconciliation), `git commit`, `git push`, `git merge`, and passing test runs—while keeping every completed step in a collapsible `▸ Completed · N` section and `/upnext done`.
- **Hands off across sessions, PRs, and GitHub Issues** with `/upnext wrap`, `/upnext carry`, `/upnext pr`, and two-way `/upnext issues [import]`.

## How it looks

Claude finishes a reply with five suggestions. `upnext` ranks them and puts the three that matter most right above the prompt box, each with the reason it matters:

![The top three steps, ranked with reasons, above the Claude Code prompt box](docs/above-the-prompt.png)

From an empty prompt box, `1` `2` `3` act on a step (a prompt `○` is drafted, a check `☐` is ticked off, a decision `?` starts your answer); `0` hides the band until the next turn.

Open the full tree beside the transcript with `/upnext`:

<p align="center"><img src="docs/full-list.png" alt="The full Up next list in a pane beside the transcript" width="520"></p>

## Install

In a Claude Code terminal session:

```
/plugin install upnext --marketplace rseac/upnext
```

Or from a shell:

```
claude plugin install upnext --marketplace rseac/upnext
```

In the desktop app: click **+** next to the prompt box → **Plugins** → **Add marketplace** (`rseac/upnext`) → **Add plugin**.

<details>
<summary><strong>Set up with an agent (one-paste automated setup)</strong></summary>

Paste this into a Claude Code session:

```
Set up upnext by following the "Set up with an agent" section of the README in the GitHub repo rseac/upnext.
```

### Steps for the agent

Do these in order. Report each step's result in one line. Stop and ask the person before changing anything not listed here.

1. **Check it is not installed already.** Run `claude plugin list`. If `upnext` is listed and enabled, skip to step 4.
2. **Add the marketplace:** `claude plugin marketplace add rseac/upnext`
3. **Install for this user:** `claude plugin install upnext@upnext -s user`, then confirm `upnext` shows as enabled in `claude plugin list`.
4. **Formatting rule in `~/.claude/CLAUDE.md`:** Open `~/.claude/CLAUDE.md` (create it if missing). If it does not already mention `upnext`, append:
   ```markdown
   ## upnext
   When a reply has concrete follow-ups, end with a `## Next steps` section ordered most important first. Prefix each bullet with its short topic in brackets (e.g. `- [Auth] Rotate the signing key`), and add `[check]` (for the user to try/verify) or `[decide]` (for a choice the user must make) when a step is for the user rather than a prompt for you. Omit `## Next steps` when no follow-up is needed.
   ```
5. **Settings (only if asked).** Reinstall with `--config`, e.g. `claude plugin install upnext@upnext -s user --config rank=local`.
6. **herdr (only if `command -v herdr` succeeds).**
   1. Find the installed copy: `find ~/.claude/plugins -name herdr-plugin.toml -path '*upnext*' | head -1`.
   2. Link it: `herdr plugin link <that folder>`.
   3. If `~/.config/herdr/config.toml` does not already bind `prefix+u` or define `[ui.sidebar.agents]`, append the TOML block from [Inside herdr](#inside-herdr) (ask first if either exists).
   4. Run `herdr config check`, and if `Config: ok`, run `herdr server reload-config`.
   5. Check `python3 --version` works.
7. **Finish.** Tell the person to restart Claude Code.

Undo: `claude plugin uninstall upnext@upnext`, and in herdr `herdr plugin unlink upnext` plus removing the block from `~/.config/herdr/config.toml`.

</details>

## How it works

### 1. Plan consolidation & frontier ranking ("Most important first")
- **Unified plan + reply tree:** when a plan is written or edited (`ExitPlanMode`, `~/.claude/plans/*.md`, `PLAN.md`, `NEXT_STEPS.md`, `TODO.md`, `docs/*plan*.md`, or `/upnext plan [file]`), its steps form the spine of the list. Reply suggestions that refine a plan step update its prompt in place; tactical sub-actions nest as `+N` children under the plan step they serve.
- **Plan frontier + active-topic scoring:** the first uncompleted step in the active plan (the frontier) and any immediate blocker or failing test rank at the top (`1` `2` `3`), while later plan phases wait in sequence until earlier steps are done. Completed plan steps stay visible as `✓` in the Plan view (`p`).
- **Haiku reconciliation & ranking (`rank: auto`):** after each typed turn, Haiku checks which open steps the turn completed or superseded (recording completed ones in `▸ Completed · N`), and re-ranks when 4+ steps are open.

### 2. Steps for Claude (`○`) vs. steps for you (`☐` / `?`)

| Mark | Kind | Example | Action on click / key |
| --- | --- | --- | --- |
| `○` | Prompt for Claude | `Add integration tests for the parser` | Drafts (or sends) the prompt |
| `☐` | For you to try/check | `Try the new pane` · `Verify the output` | Drafts (or sends) the check prompt |
| `?` | For you to decide | `Pick a license` · `Say whether to build X` | Starts your answer: `Pick a license: ` |

Press `w` on any step to cycle `○` → `☐` → `?`. Your steps stay out of ghost text, stream `▶`, `▶▶`, and agent hand-offs.

### 3. Streams, completed history & aging
- **Streams (`●`) & Plan view (`◎`):** steps are grouped by line of work (`[Topic]` tags, section headings, or shared words), each with its own color. Press `p` above the prompt (or `v` inside the pane) to focus on the active **Plan**, edit (`✎`) to rename or merge streams, or archive (`⊟`).
- **Completed history (`▸ Completed · N` & `/upnext done`):** completed and superseded steps are persisted per session so you can unfold `▸ Completed` in the pane or herdr viewer, run `/upnext done`, or export them in `/upnext export`, `/upnext wrap`, and `/upnext pr`.
- **Auto-cleaning & aging:** non-plan steps clear once done (`clearDoneAfter: 0`), while untouched steps fade after 10 turns (`fadeAfter`) and fold into **older** (`o`) after 30 turns (`oldAfter`). Typed prompts, `git commit`, `git push`, `git merge`, and passing test runs auto-tick matching steps.
- **Safety:** ANSI escapes and invisible/tag characters (`U+E0000`–`U+E007F`) are stripped or dropped before any step is shown or sent.

## Session handoff, PR summaries & GitHub Issues

- **Plan view (`/upnext plan [file]` or `p`):** loads `PLAN.md`, `NEXT_STEPS.md`, `TODO.md`, or any specified plan file, consolidates open suggestions into it, and opens the pane focused on the plan (`done/total done`).
- **Completed log (`/upnext done`):** prints all steps completed during the session.
- **Wrap up (`/upnext wrap [file]`):** saves open steps plus a handoff header (`> Goal`, `> Latest`, `> Completed`, `> Checkpoint`) to `NEXT_STEPS.md`. Up to 30 completed steps are remembered per session even after they leave the pane.
- **Carry over (`/upnext carry [file]`):** new sessions automatically toast when `NEXT_STEPS.md` is present; `/upnext carry` imports its open steps marked `"earlier"` (building self-contained prompts on click).
- **PR summary (`/upnext pr`):** drafts a prompt asking Claude to write a PR title and description from the session's completed steps and remaining follow-ups.
- **Two-way GitHub Issues (`/upnext issues [import]`):** `/upnext issues` drafts a prompt to create GitHub issues from open steps; `/upnext issues import` pulls open issues (`gh issue list`) into an **Issues** stream and reminds you to close `#N` when done.
- **Compaction & `/clear`:** during context compaction, `upnext` passes the 15 newest open steps to the summarizer so file/function context is preserved.

## Commands & shortcuts

| Command / Key | What it does |
| --- | --- |
| `/upnext` · `/upnext <stream>` · `/upnext all` | Open the pane · filter to one stream · show all streams |
| `/upnext plan [file]` · `/upnext done` | Load/focus the active plan in the pane · list all completed steps in this session |
| `/upnext wrap [file]` · `/upnext carry [file]` | Save handoff + checklist (`NEXT_STEPS.md`) · import open steps into a new session |
| `/upnext pr` · `/upnext export [file]` | Draft a PR summary from completed + open steps · export open + completed Markdown checklist |
| `/upnext issues` · `/upnext issues import` | Draft GitHub issues from open steps · import open GitHub issues via `gh` |
| `/upnext herdr` · `/upnext split` · `/upnext clear` | Open herdr popup · open herdr split pane · clear all steps |
| `1` `2` `3` / `p` / `0` (empty prompt) · `Tab` | Act on top 3 steps above prompt / open Plan pane / hide band · accept ghost text |
| Click / `▶` / `✎` / `✕` (in pane) | Draft step / send immediately / edit or move / dismiss |
| `▶▶` / `⇶` (on a stream) | Run stream in order (with git `HEAD` checkpoint) / hand steps to background agents |
| `j` `k` · `d` `s` `x` `w` · `m` `r` `u` | Move highlight · draft, send, drop, cycle who · mark steps, run marked in order, unmark |
| `v` / `a` · `p` · `t` · `c` · `e` · `o` · `z` · `q` | Focus Plan / show all · re-rank · tidy · clear done · unfold rest · unfold older · fold all · stop `▶▶` |

## Inside herdr

When Claude Code runs inside [herdr](https://herdr.dev), `prefix+u` opens the tree as a popup over Claude's pane, herdr's sidebar shows `3 next · Auth: Rotate the key`, and `➜` (`h`) hands a step (or marked steps) directly to another agent pane (Claude, Codex, etc.).

<p align="center"><img src="docs/herdr-popup.png" alt="The Up next popup in herdr" width="540"></p>

<details>
<summary><strong>herdr one-time setup & keyboard shortcuts</strong></summary>

1. Link the plugin:
   ```
   herdr plugin link <path to upnext>/herdr
   ```
2. Add to `~/.config/herdr/config.toml`, then run `herdr server reload-config`:
   ```toml
   [[keys.command]]
   key = "prefix+u"
   type = "plugin_action"
   command = "upnext.open"
   description = "Up next"

   [ui.sidebar.agents]
   row_gap = 0
   rows = [
     ["state_icon", "machine", "workspace", "tab"],
     ["agent"],
     [{ token = "$upnext", dim = true }],
   ]
   ```

| Mouse / Keys | Action in herdr popup or split |
| --- | --- |
| Click step / `1`–`9` / `Enter` / `d` | Draft step in Claude's prompt box |
| `j` `k` ↓ ↑ `g` `G` / `Space` | Move highlight / fold or unfold stream |
| `▶` (`s`) / `➜` (`h`) | Send step (or stream) / hand off to another herdr agent pane |
| `m` / `u` / `r` | Mark or unmark (`◆`) / clear marks / run marked steps in order |
| `w` / `p` / `t` / `c` | Cycle who (`○`/`☐`/`?`) / re-rank / tidy / clear done |
| `⊟` (`a`) / `✕` (`x`) / `q` (`Esc`) | Archive stream / dismiss / close popup |

</details>

## Options

<details>
<summary><strong>All configuration options (<code>claude plugin install upnext@upnext -s user --config key=value</code>)</strong></summary>

| Option | Default | Meaning |
| --- | --- | --- |
| `clickAction` | `draft` | `draft` fills the prompt box; `send` sends immediately (`✐` then drafts). |
| `extractor` | `auto` | `auto`: fast parser + session fork only when a reply lists nothing. `heuristic`: parser only. `model`: always ask fork. |
| `rank` | `auto` | `auto`: free active-topic score + Haiku re-rank & noise pruning. `local`: free score only. `off`: plain list. |
| `band` / `bandStyle` | `true` / `list` | Show top 3 steps above prompt (`list`: 3 lines with reasons; `row`: 1 compact line). |
| `ghostText` / `statusLine` | `true` / `true` | Offer top step as Tab ghost text / show `✦ N next steps` in status line. |
| `autoTick` / `scanToolOutput` | `true` / `true` | Auto-tick from `git commit`, `git push`, and passing tests / read `TodoWrite` & `TaskCreate`. |
| `clearDoneAfter` | `0` | Turns before a `✓` step leaves (`0`: end of turn; negative: keep until cleared). |
| `fadeAfter` / `oldAfter` | `10` / `30` | Untouched turns before a step fades / moves to folded **older** group (`0` disables). |
| `nudgeAfter` / `minAnswerChars` | `10` / `80` | Idle turns before a stream toast (`0` disables) / shortest reply that triggers a model call. |
| `keepAcrossSessions` / `autoOpen` | `true` / `false` | Restore session steps on `--resume` / auto-open side pane when steps arrive. |
| `paneStyle` / `herdrLabel` / `herdrGlyphs` | `auto` / `true` / `symbols` | `auto` (herdr popup), `split`, or `claude` / set herdr sidebar token / `symbols` or `ascii`. |

</details>

## Acknowledgments

Session wrap-up handoffs (`/upnext wrap` & `/upnext carry`), proof-based step completion, git checkpoints on sequential runs (`▶▶`), stream drift notices, PR summary drafting (`/upnext pr`), and GitHub issue import (`/upnext issues import`) were inspired by [`archid21/whatsnext`](https://github.com/archid21/whatsnext).

## License

MIT. See [LICENSE](LICENSE).
