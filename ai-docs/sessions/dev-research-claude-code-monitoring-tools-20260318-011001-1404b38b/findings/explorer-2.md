# Research Findings: CLI AI Agent Monitoring and State Detection

**Researcher**: Explorer 2
**Date**: 2026-03-18
**Model Strategy**: native (local codebase investigation + system-level experiments)
**Queries Executed**: 18 (local codebase grep/read, live system experiments with ps/lsof/tmux/psutil)

---

## Key Findings

### Finding 1: The Sirko Codebase Already Implements a Weighted Three-Signal Detector

**Summary**: The local Sirko codebase contains a production-grade detection engine that combines three independent signals into a weighted score to determine when a CLI agent is waiting for input.

**Evidence**:

The `DetectorEngine` in `packages/detector/src/engine.ts` computes:

```
score = (S_prompt * promptPatternWeight)
      + (S_wchan  * wchanWeight)
      + (S_quiescence * quiescenceWeight)
awaiting = score >= scoringThreshold
```

Per-agent skill configurations in `packages/tool-plugins/src/plugins/`:

| Agent | Prompt Pattern Weight | Wchan Weight | Quiescence Weight | Threshold |
|---|---|---|---|---|
| claude-code | 0.45 | 0.35 | 0.20 | 0.60 |
| codex | 0.55 | 0.30 | 0.15 | 0.65 |
| aider | 0.50 | 0.30 | 0.20 | 0.55 |

The design is intentionally fuzzy: no single signal is required. All three can partially fire and their weighted sum can cross the threshold.

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/detector/src/engine.ts` - Quality: high (primary source)
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/claude-code.ts` - Quality: high
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/aider.ts` - Quality: high
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/codex.ts` - Quality: high

**Confidence**: High
**Multi-source**: Yes (multiple implementation files corroborate)

---

### Finding 2: macOS wchan Is Not Reliable — ps -o wchan Returns "-" for All Processes

**Summary**: On macOS/Darwin, the BSD `ps` implementation does not expose meaningful wait-channel (wchan) values. The `MacosWchan` implementation in Sirko works around this with caching but returns `-` (empty/dash) for essentially all processes, making this signal unreliable on macOS.

**Evidence**:

Live system test confirmed:
```bash
$ ps -o pid,wchan -p <any_pid>
  PID WCHAN
 1234 -
```

The macOS XNU kernel redacts wchan from BSD `ps` output. This is a fundamental platform limitation — not a bug in the Sirko implementation. The `MacosWchan` class in `packages/detector/src/wchan.ts` uses `ps -o wchan= -p <pid>` which consistently returns `-` or empty string.

Linux contrast: On Linux, `/proc/<pid>/wchan` exposes the kernel function name the process is blocked in (e.g., `pipe_read`, `futex`, `do_select`). The `LinuxWchan` class reads this file directly. Values like `pipe_read` are a strong signal that a process is blocked waiting for stdin input through a pipe.

This means:
- **Linux**: wchan is a strong, cheap, reliable signal (file read)
- **macOS**: wchan signal effectively contributes 0 to the score; detection relies more heavily on prompt patterns (weight 0.45) and quiescence (weight 0.20)

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/detector/src/wchan.ts` - Quality: high
- Live experiment: `ps -o wchan= -p $$` returning `-` - Quality: high
- Live experiment: `ps -eo pid,wchan | head -20` showing `-` for all processes - Quality: high

**Confidence**: High
**Multi-source**: Yes

---

### Finding 3: tmux Control Mode Is the Primary Event Source — Its Protocol Delivers Real-Time Output

**Summary**: tmux's control mode (`tmux -C`) emits a line-protocol stream that provides real-time notification of pane output, pane exit, and session lifecycle events. This is the most reliable foundation for agent monitoring.

**Evidence**:

Live test of `tmux -C` control mode output format:
```
%begin 1773756731 1262 0       # start of command response block
%end 1773756731 1262 0         # end of command response block
%session-changed $0 research   # session lifecycle event
%output %0 <escaped_data>      # pane output with octal/backslash escaping
%pane-exited %3 $1             # pane exit notification
```

The Sirko `TmuxClient` (`packages/tmux-client/src/client.ts`) spawns `tmux -L <socket> -C new-session -A -s sirko-bot` and processes the stream via a `_readLoop`. The `parseControlModeLine` parser handles:
- `%output` → `pane-output` event (raw VT100/ANSI data)
- `%pane-exited` → `pane-exited` event
- `%session-created/closed` → lifecycle events
- `%window-add/close` → window events
- `%begin/%end/%error` → command response delimiters (FIFO queue)

The `OutputCoalescer` debounces rapid `%output` events for the same pane within a 50ms window to avoid processing each individual character as a separate event.

tmux format variables useful for monitoring:
- `#{pane_pid}` — foreground process PID
- `#{pane_current_command}` — current process name
- `#{pane_dead}` — 1 if process has exited
- `#{pane_tty}` — TTY device path
- `#{cursor_x}`, `#{cursor_y}`, `#{cursor_character}` — cursor position/content

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/tmux-client/src/client.ts` - Quality: high
- `/Users/jack/mag/magai/sirko/packages/tmux-client/src/parser.ts` - Quality: high
- `/Users/jack/mag/magai/sirko/packages/tmux-client/src/coalescer.ts` - Quality: high
- Live experiment: `tmux -C attach-session` output - Quality: high

**Confidence**: High
**Multi-source**: Yes

---

### Finding 4: Claude Code Writes Structured JSONL Session Files and Hook-Based State Events

**Summary**: Claude Code writes JSONL files to `~/.claude/projects/<project-path>/<session-id>.jsonl` that contain structured records of all turns. The `Stop` hook fires after every completed turn, providing a reliable signal that the agent has finished processing and is waiting for user input.

**Evidence**:

JSONL entry types observed in live session files:
- `user` — user input record
- `assistant` — model response record
- `progress` — streaming tool-use progress entries
- `system` (subtype: `stop_hook_summary`) — fires when a turn ends; contains hook execution info
- `system` (subtype: `turn_duration`) — records turn duration in ms
- `queue-operation` (operation: `enqueue/dequeue/remove`) — message queue management
- `last-prompt` — most recent prompt text

The `Stop` hook (configured in `~/.claude/settings.json`) fires reliably after each completed turn. This enables an alternative detection approach: watch the JSONL file for `system:stop_hook_summary` entries via filesystem watching (FSEvents on macOS, inotify on Linux).

The `.lock` file at `~/.claude/tasks/<task-id>/.lock` is created when a task is active. These lock files exist for all in-progress Claude Code tasks.

**Sources**:
- Live inspection of `~/.claude/projects/-Users-jack-mag-magai-sirko/b0a575aa-bf90-401b-99db-4730331e788f.jsonl` - Quality: high
- `~/.claude/settings.json` hooks configuration - Quality: high
- `~/.claude/tasks/*/` directory structure - Quality: high

**Confidence**: High
**Multi-source**: Yes (multiple session files confirmed same structure)

---

### Finding 5: Claude Code's Stop Hook Is a First-Class Monitoring Signal for Input-Awaiting State

**Summary**: The `tmux-claude-continuity` plugin (installed locally) demonstrates a real-world hook-based monitoring approach. The Claude Code `Stop` hook fires exactly when the agent completes a turn and is waiting for the next user input.

**Evidence**:

The `on_stop.sh` script at `~/.tmux/plugins/tmux-claude-continuity/scripts/on_stop.sh` demonstrates:
- Receives JSON via stdin when the `Stop` hook fires
- Parses `session_id` and `cwd` from the JSON
- Maps pane identity via `tmux display-message -p '#S-#I-#P'`
- Reads the JSONL file to find the latest `customTitle`
- Writes state to a per-pane sidecar file

This pattern can be extended for Sirko: the `Stop` hook could write a JSON file to a known location that Sirko watches, eliminating the need to infer waiting state from tmux output patterns. The hook approach is deterministic (no false positives from prompt pattern matching).

However, this approach only works for Claude Code (not Aider or Codex CLI), and requires user configuration of hooks.

**Sources**:
- `/Users/jack/.tmux/plugins/tmux-claude-continuity/scripts/on_stop.sh` - Quality: high
- `/Users/jack/.tmux/plugins/tmux-claude-continuity/README.md` - Quality: high

**Confidence**: High
**Multi-source**: No (Claude Code-specific)

---

### Finding 6: Prompt Pattern Matching via xterm/headless Buffer Is the Most Portable Signal

**Summary**: Each CLI agent emits distinctive prompt characters when ready for input. Parsing the terminal buffer through a headless VT100 emulator and matching prompt patterns is the most portable and tool-agnostic detection approach.

**Evidence**:

Prompt patterns by agent (from `packages/tool-plugins/src/plugins/`):

| Agent | Prompt Patterns |
|---|---|
| claude-code | `^>\s*$` (line containing only `>`) or `^❯[\s\u00a0]*$` (Unicode right arrow) |
| aider | `^> ` (standard prompt), `\(y\/n\)` (confirmation), `\[Yes\]`, `\[No\]` |
| codex | `^\? ` (inquirer-style), `Continue?`, `Proceed?` |

The Sirko `XtermEmulator` wraps `@xterm/headless` to process raw VT100/ANSI escape sequences and produce clean text. The `BufferEmulator` fallback uses a regex-based ANSI stripper. The `PromptMatcher` tests each pattern against the current buffer.

Live tmux output confirmed: Claude Code emits `❯` (U+276F) as its prompt character when waiting for input. The raw output is escaped by tmux (`\033[38;2;255;106;193m❯\033[0m`). After xterm processing, this becomes the bare `❯` character that the regex can match.

Cursor position analysis: `#{cursor_x}` and `#{cursor_y}` from tmux are not directly useful for detecting the waiting state — cursor position doesn't reliably distinguish "prompt cursor" from "output cursor."

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/` (all skill files) - Quality: high
- `/Users/jack/mag/magai/sirko/packages/tmux-client/src/xterm-emulator.ts` - Quality: high
- `/Users/jack/mag/magai/sirko/packages/detector/src/prompt-matcher.ts` - Quality: high
- Live tmux control-mode output showing `❯` ANSI-escaped - Quality: high

**Confidence**: High
**Multi-source**: Yes

---

### Finding 7: Quiescence (Output Silence Timer) Is the Universal Fallback Signal

**Summary**: Measuring elapsed time since the last terminal output is a reliable fallback signal when prompt patterns and wchan are inconclusive. Each agent has a tuned quiescence threshold.

**Evidence**:

The `QuiescenceScheduler` (`apps/orchestrator/src/quiescence-scheduler.ts`) polls all tracked panes every N ms and injects synthetic `quiescence-check` events into the pipeline for panes where `now - lastOutputTime >= skill.quiescenceThresholdMs`.

Quiescence thresholds by agent:
- claude-code: 1800ms
- codex: 1500ms
- aider: 3000ms

The `QuiescenceTracker` returns a score in `[0, 1]` via `min(silenceMs / threshold, 1.0)`. A partial score accumulates even before the threshold is fully reached.

This signal is inherently agent-agnostic (any process that stops writing to the terminal shows quiescence). Its weakness is that it cannot distinguish between "agent is thinking" (still processing, hasn't output yet) and "agent is waiting for input." Hence its lower weight (0.15-0.20) vs. prompt patterns (0.45-0.55).

**Sources**:
- `/Users/jack/mag/magai/sirko/apps/orchestrator/src/quiescence-scheduler.ts` - Quality: high
- `/Users/jack/mag/magai/sirko/packages/detector/src/quiescence.ts` - Quality: high

**Confidence**: High
**Multi-source**: Yes

---

### Finding 8: Process Detection — psutil Gives "running" Status Even for Stdin-Blocked Processes on macOS

**Summary**: The Python `psutil` library reports `status: running` for processes blocked on stdin read on macOS. The macOS kernel does not expose a meaningful "blocked on stdin" state through `ps` or `psutil`. Process status inspection is not a reliable method on macOS for detecting the input-waiting state.

**Evidence**:

Live experiment:
```python
import psutil, subprocess, time
proc = subprocess.Popen(['python3', '-c', 'import sys; sys.stdin.read()'], stdin=subprocess.PIPE)
time.sleep(0.2)
p = psutil.Process(proc.pid)
print('status:', p.status())  # → "running"
```

On Linux, `psutil` status would show `sleeping` (TASK_INTERRUPTIBLE) for a process blocked on `read()`. On macOS, the XNU scheduler does not distinguish blocked-on-IO from running in the process status field visible to userspace.

The `ps -o stat` column shows `S` (sleeping) for stdin-blocked processes but also for actively sleeping processes — not a reliable distinguisher.

**Sources**:
- Live experiment: `psutil.Process(pid).status()` returning `"running"` for blocked process - Quality: high
- Live experiment: `ps -o pid,stat` showing `S` for both blocked and computing processes - Quality: high

**Confidence**: High
**Multi-source**: No (macOS-specific)

---

### Finding 9: TTY-Based Monitoring via lsof Is Possible but Heavyweight

**Summary**: `lsof <tty-device>` lists all processes with that TTY open. The `#{pane_tty}` tmux format variable exposes the TTY path. However, this approach requires spawning `lsof` (expensive) and parsing its output without providing information about whether any process is blocking on read.

**Evidence**:

Live experiment:
```bash
TTY=$(tmux display-message -t %26 -p "#{pane_tty}")
# → /dev/ttys031
lsof "$TTY"
# COMMAND PID  USER FD TYPE DEVICE SIZE/OFF NODE NAME
# zsh     4804 jack  0u  CHR 16,31 ...      1427 /dev/ttys031
# 2.1.72  37492 jack 4r  CHR 16,31 ...      1427 /dev/ttys031
```

The `FD` column shows `4r` (file descriptor 4, open for read) for the agent process. However, many processes have the TTY open for reading even when not blocking on it. `lsof` does not indicate blocking state — only that the FD is open.

**Sources**:
- Live experiment: `lsof /dev/ttys031` output - Quality: high
- Live experiment: `tmux display-message -p "#{pane_tty}"` - Quality: high

**Confidence**: High
**Multi-source**: No

---

### Finding 10: dtrace/ptrace Syscall Monitoring Is Available on macOS but Restricted by SIP

**Summary**: macOS has `dtrace` and `dtruss` for syscall-level monitoring. These would enable detecting `read()` syscall blocking. However, System Integrity Protection (SIP) restricts their use in practice — they require a special entitlement or SIP disabled.

**Evidence**:

```bash
$ which dtrace
/usr/sbin/dtrace
$ ls -la /dev/dtrace
crw-rw-rw-  1 root  wheel  0x18000011  /dev/dtrace
```

The `/dev/dtrace` device is present and world-readable, but in practice DTrace on macOS requires either: (a) SIP disabled, (b) the binary has a DTrace entitlement, or (c) running as root. For a typical dev tool, ptrace/dtrace is not a viable approach.

On Linux, `strace -p <pid>` can intercept syscalls including `read()` blocking. This is less restricted but still requires elevated permissions or setting `/proc/sys/kernel/yama/ptrace_scope` to 0.

**Sources**:
- Live system check: `ls -la /dev/dtrace` - Quality: high
- Live system check: `which dtruss` - Quality: high

**Confidence**: High
**Multi-source**: No

---

### Finding 11: Agent Tool Detection Uses Binary/Process Name Pattern Matching

**Summary**: Identifying which AI agent is running in a pane uses process name matching against skill-defined regex patterns, combined with checking process arguments.

**Evidence**:

The `detectTool` function in `packages/tool-plugins/src/detect.ts`:
```typescript
for (const skill of orderedSkills) {  // [claude-code, codex, aider]
  for (const proc of processes) {
    const binaryMatch = skill.binaryPattern.test(proc.name) ||
      proc.argv.some(arg => skill.binaryPattern.test(arg))
    const nameMatch = skill.processNamePattern.test(proc.name)
    if (binaryMatch || nameMatch) return skill.name
  }
}
return 'unknown'
```

Binary patterns:
- claude-code: `/claude$/i`
- codex: `/codex$/i`
- aider: `/aider$/i`

The `#{pane_current_command}` tmux format variable gives the foreground command name, which is the cheapest way to identify which agent is running. The `#{pane_pid}` gives the process PID for deeper inspection.

**Sources**:
- `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/detect.ts` - Quality: high
- Live experiment: `tmux list-panes -F "#{pane_id} #{pane_pid} #{pane_current_command}"` - Quality: high

**Confidence**: High
**Multi-source**: Yes

---

### Finding 12: Named Pipes and IPC Are Not Used by Existing Agents — Filesystem Watching Is the Practical Alternative

**Summary**: None of the monitored agents (Claude Code, Aider, Codex CLI) expose named pipes or IPC sockets for state monitoring. Filesystem watching of their output files (JSONL for Claude Code, log files for Aider) is the only agent-native IPC channel available.

**Evidence**:

Claude Code's monitoring surface:
- `~/.claude/projects/<project>/<session-id>.jsonl` — append-only JSONL file
- `~/.claude/tasks/<task-id>/.lock` — lock files for active tasks
- `Stop` hook output — can be directed to any file/process

Aider: no known status files discovered. Aider relies entirely on terminal output monitoring.

Codex CLI: no known status files discovered.

For filesystem watching:
- macOS: FSEvents API (via Node/Bun `fs.watch()` or `chokidar`)
- Linux: inotify (via Node/Bun `fs.watch()`)

Watching the JSONL file for new `system:stop_hook_summary` lines would provide a deterministic, zero-latency signal for Claude Code input-waiting state. This approach requires no wchan, no prompt pattern matching, and no quiescence timer.

**Sources**:
- Live inspection of `~/.claude/` directory structure - Quality: high
- Live experiment: `find ~/.claude -name "*.lock"` - Quality: high

**Confidence**: High
**Multi-source**: No (agent-specific)

---

## Source Summary

**Total Sources**: 18 queries executed
- High Quality: 18 (all from primary sources: local codebase + live system experiments)
- Medium Quality: 0
- Low Quality: 0

**Source List**:
1. `/Users/jack/mag/magai/sirko/packages/detector/src/engine.ts` - Quality: high (main detection engine)
2. `/Users/jack/mag/magai/sirko/packages/detector/src/wchan.ts` - Quality: high (platform-specific wchan)
3. `/Users/jack/mag/magai/sirko/packages/detector/src/prompt-matcher.ts` - Quality: high
4. `/Users/jack/mag/magai/sirko/packages/detector/src/quiescence.ts` - Quality: high
5. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/claude-code.ts` - Quality: high
6. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/aider.ts` - Quality: high
7. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/plugins/codex.ts` - Quality: high
8. `/Users/jack/mag/magai/sirko/packages/tool-plugins/src/detect.ts` - Quality: high
9. `/Users/jack/mag/magai/sirko/packages/tmux-client/src/client.ts` - Quality: high
10. `/Users/jack/mag/magai/sirko/packages/tmux-client/src/parser.ts` - Quality: high
11. `/Users/jack/mag/magai/sirko/packages/tmux-client/src/coalescer.ts` - Quality: high
12. `/Users/jack/mag/magai/sirko/packages/tmux-client/src/xterm-emulator.ts` - Quality: high
13. `/Users/jack/mag/magai/sirko/apps/orchestrator/src/quiescence-scheduler.ts` - Quality: high
14. `/Users/jack/mag/magai/sirko/packages/pipeline/src/middleware/detection.ts` - Quality: high
15. `/Users/jack/.tmux/plugins/tmux-claude-continuity/scripts/on_stop.sh` - Quality: high
16. `/Users/jack/.tmux/plugins/tmux-claude-continuity/README.md` - Quality: high
17. Live system experiments (ps, lsof, tmux, psutil) - Quality: high
18. `~/.claude/projects/*/` JSONL session files - Quality: high

---

## Knowledge Gaps

What this research did NOT find:

- **Aider and Codex CLI filesystem artifacts**: No lock files, status files, or IPC mechanisms were found for Aider or Codex CLI. Detection for these tools must rely entirely on terminal output monitoring (prompt patterns + quiescence). Suggested query: `"aider" status file OR "codex cli" monitoring approach`

- **Cursor agent monitoring**: The research question mentioned Cursor agent but no Cursor-specific detection was investigated. Cursor runs as an IDE extension, not a standalone CLI, so terminal-based monitoring may not apply. Suggested query: `"cursor agent" process monitoring detection`

- **Claude Code SDK/output JSON mode**: Claude Code has a `--output-format json` flag that enables machine-readable output. Whether this provides structured state events was not investigated. Suggested query: `"claude" "--output-format" json monitoring`

- **Linux wchan values in practice**: The specific wchan values that Claude Code, Aider, and Codex show on Linux when waiting for stdin (`pipe_read`, `futex`, etc.) were not verified via live testing (no Linux host available). The values in the Sirko skill definitions are design choices, not empirically validated.

- **Alternative: process file descriptor state inspection**: On Linux, `/proc/<pid>/fdinfo/<fd>` provides file descriptor state including blocking state. This could be a more precise signal than wchan. Not investigated.

---

## Summary of Detection Approaches (Ranked by Reliability)

| Approach | Platform | Reliability | Cost | Notes |
|---|---|---|---|---|
| Claude Code `Stop` hook | All | Deterministic | Low | Requires user config; Claude Code only |
| tmux `%output` + xterm buffer + prompt pattern | All | High | Medium | Works for all agents; requires VT parsing |
| Linux `/proc/<pid>/wchan` | Linux only | High | Very low | Free kernel signal; `pipe_read` = blocked on stdin |
| Quiescence timer (output silence) | All | Medium | Low | False positives when agent is "thinking" |
| macOS `ps -o wchan` | macOS only | Low | Low | Always returns `-`; unreliable |
| `lsof <tty>` analysis | All | Low | High | Doesn't show blocking state; expensive |
| dtrace/ptrace syscall monitoring | All (restricted) | High | Very high | SIP restriction on macOS; requires root on Linux |
| JSONL file watching (FSEvents/inotify) | All | High | Low | Claude Code only; stop_hook_summary entries |

---

## Search Limitations

- Model: claude-sonnet-4-6 (native, no web search)
- Web search: unavailable (MODEL_STRATEGY=native)
- Local search: performed extensively
- Date range: 2026-03-18 (current codebase state)
- External research: not performed (no web access)
- Platforms tested: macOS Darwin 25.3.0 only; Linux behavior documented from code but not live-tested
