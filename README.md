<p align="center">
  <img src=".claude-plugin/icon.png" alt="upnext" width="180">
</p>

<h1 align="center">upnext — Next Steps, Task Queue & Session Handoff for Claude Code</h1>

<p align="center">
  <strong>A Claude Code plugin that captures, ranks, and runs the next steps Claude suggests—right above your prompt box, in a side pane, or across background agents.</strong>
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

Most Claude Code replies end with follow-up suggestions ("Next steps", "Want me to also…", or open tasks across workstreams). In a real session they go wrong in predictable ways:

- **They scroll away** as new replies bury earlier suggestions.
- **You lose track of what matters now** when switching between several lines of work.
- **Acting on one means retyping** or copy-pasting back into the prompt box.
- **Not every suggestion is a prompt**—things for you to try (`☐`) or decide (`?`) are mixed in with tasks for Claude (`○`).
- **Context is lost between sessions** when you `/clear`, `/compact`, or start a fresh chat.

## What upnext does

- **Collects** next steps automatically from Claude's replies, closing offers, `TodoWrite` / `TaskCreate` lists, and GitHub Issues—using `[Topic]` and `[check]` / `[decide]` tags so extraction takes `<1ms` with zero extra LLM calls.
- **Follows your active conversation** and shows the top three steps (with reasons, stream colors, and `+N` sub-step counts) right above the prompt box. Press `1`, `2`, or `3` to act on one immediately.
- **Verifies and clears** steps as they get done: by a prompt you type, a `git commit`, a `git push`, a passing test run, or a click—while marking steps `✗` if a Bash/test command in their turn fails, and dropping superseded steps when you change direction.
- **Separates** steps for you (`☐` try/check, `?` decide) from prompts for Claude (`○`), so yours are never sent by accident.
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

### 1. Active-topic ranking ("Most important first")
- **Free, every turn:** scores steps by active conversation focus (latest turn, active stream, overlap with your latest prompt and Claude's reply), failed attempts (`✗`), active test failures, and blockers (`security`, `crash`, `before merging`). Steps from earlier topics smoothly decay each turn as you move on.
- **Haiku refinement (`rank: auto`):** when 4+ steps are open and new ones arrive (or focus shifts), Haiku reads a short brief (open steps with turn age, recent prompts, start of last reply, test failures) to re-rank the top 5, refine `forYou` labels, and drop non-actionable noise or duplicates. Press `p` to re-rank anytime.

### 2. Steps for Claude (`○`) vs. steps for you (`☐` / `?`)

| Mark | Kind | Example | Action on click / key |
| --- | --- | --- | --- |
| `○` | Prompt for Claude | `Add integration tests for the parser` | Drafts (or sends) the prompt |
| `☐` | For you to try/check | `Try the new pane` · `Check that ✓ steps leave` | Ticks it off (`✓`) |
| `?` | For you to decide | `Pick a license` · `Say whether to build X` | Starts your answer: `Pick a license: ` |

Press `w` on any step to cycle `○` → `☐` → `?`. Your steps stay out of ghost text, stream `▶`, `▶▶`, and agent hand-offs.

### 3. Streams & aging
- **Streams (`●`):** steps are grouped by line of work (`[Topic]` tags, section headings, or shared words), each with its own color. Edit (`✎`) to rename or merge streams, focus on one stream (`◎` or `/upnext <stream>`, with a drift toast if new steps land elsewhere), or archive (`⊟`).
- **Auto-cleaning & aging:** completed steps (`✓`) clear at turn end (`clearDoneAfter: 0`), untouched steps fade after 10 turns (`fadeAfter`) and fold into **older** (`o`) after 30 turns (`oldAfter`). Typed prompts, `git commit`, `git push`, and passing test runs auto-tick matching steps.
- **Safety:** ANSI escapes and invisible/tag characters (`U+E0000`–`U+E007F`) are stripped or dropped before any step is shown or sent.

## Session handoff, PR summaries & GitHub Issues

- **Wrap up (`/upnext wrap [file]`):** saves open steps plus a handoff header (`> Goal`, `> Latest`, `> Completed`, `> Checkpoint`) to `NEXT_STEPS.md`. Up to 30 completed steps are remembered per session even after they leave the pane.
- **Carry over (`/upnext carry [file]`):** new sessions automatically toast when `NEXT_STEPS.md` is present; `/upnext carry` imports its open steps marked `"earlier"` (building self-contained prompts on click).
- **PR summary (`/upnext pr`):** drafts a prompt asking Claude to write a PR title and description from the session's completed steps and remaining follow-ups.
- **Two-way GitHub Issues (`/upnext issues [import]`):** `/upnext issues` drafts a prompt to create GitHub issues from open steps; `/upnext issues import` pulls open issues (`gh issue list`) into an **Issues** stream and reminds you to close `#N` when done.
- **Compaction & `/clear`:** during context compaction, `upnext` passes the 15 newest open steps to the summarizer so file/function context is preserved.

## Commands & shortcuts

| Command / Key | What it does |
| --- | --- |
| `/upnext` · `/upnext <stream>` · `/upnext all` | Open the pane · filter to one stream · show all streams |
| `/upnext wrap [file]` · `/upnext carry [file]` | Save handoff + checklist (`NEXT_STEPS.md`) · import open steps into a new session |
| `/upnext pr` · `/upnext export [file]` | Draft a PR summary from completed + open steps · export a plain Markdown checklist |
| `/upnext issues` · `/upnext issues import` | Draft GitHub issues from open steps · import open GitHub issues via `gh` |
| `/upnext herdr` · `/upnext split` · `/upnext clear` | Open herdr popup · open herdr split pane · clear all steps |
| `1` `2` `3` / `0` (empty prompt) · `Tab` | Act on top 3 steps above prompt / hide band · accept ghost text |
| Click / `▶` / `✎` / `✕` (in pane) | Draft step / send immediately / edit or move / dismiss |
| `▶▶` / `⇶` (on a stream) | Run stream in order (with git `HEAD` checkpoint) / hand steps to background agents |
| `j` `k` · `d` `s` `x` `w` · `m` `r` `u` | Move highlight · draft, send, drop, cycle who · mark steps, run marked in order, unmark |
| `p` · `t` · `c` · `e` · `o` · `z` · `q` | Re-rank · tidy via session fork · clear done · unfold rest · unfold older · fold all · stop `▶▶` |

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
