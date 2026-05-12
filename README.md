# Bun closes TTY stdin after a `Bun.file()` stream reader starts 🤯

> This repo reproduces a Bun stdin bug I hit while debugging a terminal app. The affected stable releases I have confirmed start at Bun `1.2.22` and include `1.2.23`, `1.3.0`, and current `latest` (`1.3.13` when I last checked). Bun `1.2.21` is the closest confirmed green stable release. [ANALYSIS.md](./ANALYSIS.md) has the version sweep and source notes.
>
> The failure needs a specific order: Bun's Node-compatible `process.stdin` wrapper owns a TTY first, then `Bun.file(...).stream().getReader()` starts for an unrelated regular file. After that, the next stdin read can close and destroy `process.stdin`. In a terminal UI, this looks like frozen keyboard input while the process stays alive.

Submitted upstream as [oven-sh/bun#30565](https://github.com/oven-sh/bun/issues/30565).

Reading a regular file should not make keyboard input look like EOF!

This took me about three weeks to completely pin down. The reduction ruled out renderer state, keyboard handling, raw mode, mouse handling, app state, file contents, file size, lazy path opening, Node/Web stream behavior, and ordinary fd0 HUP/ERR cases. What was left is the stdin-wrapper plus BunFile-reader interaction shown here.

## Minimal shape

```ts
process.stdin.on("readable", () => {});
void Bun.file(filePath).stream().getReader();
// send one line through the TTY
```

Expected: stdin stays readable after it receives the line.

Observed with Bun `1.3.13+bf2e2cecf`: stdin emits `end` and `close`, then reports `closed=true`, `destroyed=true`, and `readable=false`.

## Run it

```bash
bun run repro
```

The runner allocates a real PTY from TypeScript using `openpty(3)` through `bun:ffi`. It sends one input line to each case and writes summaries under `artifacts/`.

Affected Bun versions produce this matrix:

| Case                | Status  | Changed variable                             | Stdin state      | Takeaway                        |
| ------------------- | ------- | -------------------------------------------- | ---------------- | ------------------------------- |
| `red`               | ❌ fail | Bun file reader starts after stdin ownership | closed/destroyed | Minimal failing interaction.    |
| delayed fd poll     | ❌ fail | Same case, with fd 0 polled before read      | closed/destroyed | Not immediate HUP/ERR/NVAL.     |
| Node-backed stream  | ✅ ok   | Use `Readable.toWeb(createReadStream(...))`  | open/readable    | Points at Bun native streams.   |
| reader before stdin | ✅ ok   | Start Bun file reader before stdin ownership | open/readable    | Order matters.                  |
| immediate cancel    | ✅ ok   | Cancel Bun file reader immediately           | open/readable    | Active reader matters.          |
| suppressed `_read`  | ✅ ok   | Suppress the post-push stdin `_read`         | open/readable    | Close happens on later `_read`. |
| Node runtime        | ✅ ok   | Run the Node-backed control under Node       | open/readable    | Bun-specific in this repro.     |

In the delayed diagnostic case, fd 0 did not report `POLLHUP`, `POLLERR`, or `POLLNVAL` immediately before the read that closes stdin.

The terminal fd is still real, the byte is delivered, and the wrapper pushes it. The close happens on the next stdin wrapper read after the unrelated Bun file reader has started.

## Bun source lead

The JS wrapper closes stdin after `reader.read()` returns done in [`src/js/builtins/ProcessObjectInternals.ts`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ProcessObjectInternals.ts#L222-L238). The suspicious edge is native stream state shared below the JS wrappers: `Bun.stdin.stream()` and file-backed `ReadableStream.fromNative(...)`.

I would start in [`src/bun.js/webcore/FileReader.zig`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/FileReader.zig#L461-L555) and [`src/io/PipeReader.zig`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/io/PipeReader.zig#L111-L113). A regular-file Blob reader must leave fd 0's native stdin source EOF state alone. If the native layer returns done to the stdin reader, the JS wrapper should destroy `process.stdin` only when that EOF belongs to stdin's own source.

## Quality checks

```bash
bun install
bun run check
```

`bun run check` runs strict TypeScript, oxlint with warnings denied, and oxfmt in check mode.

## CI

GitHub Actions runs quality checks on latest Bun, then runs the repro in "assert fixed" mode across a small Bun version matrix:

```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: latest
- run: bun run repro:assert-fixed
```

That mode expects every case to stay green. While a selected Bun version still has the bug, that matrix entry fails, prints GitHub error annotations for the red cases, writes a job summary table, and uploads the JSON summaries as artifacts. After Bun fixes the regression, the affected entries should turn green.

The matrix labels known-good versions as `control-*` and affected versions as `affected-*`. The affected rows should fail until Bun fixes the bug; the control rows should stay green. The matrix includes `latest` as a literal value, plus the current latest pinned version. That shows both "latest still fails" and the concrete version behind that result.

| Bun version | CI label                           | Status  |
| ----------- | ---------------------------------- | ------- |
| `latest`    | `affected-latest-currently-1.3.13` | ❌ fail |
| `1.3.13`    | `affected-bun-1.3.13`              | ❌ fail |
| `1.3.0`     | `affected-bun-1.3.0`               | ❌ fail |
| `1.2.23`    | `affected-bun-1.2.23`              | ❌ fail |
| `1.2.22`    | `affected-bun-1.2.22`              | ❌ fail |
| `1.2.21`    | `control-bun-1.2.21`               | ✅ ok   |
| `1.2.20`    | `control-bun-1.2.20`               | ✅ ok   |
| `1.2.10`    | `control-bun-1.2.10`               | ✅ ok   |
| `1.2.5`     | `control-bun-1.2.5`                | ✅ ok   |
| `1.2.1`     | `control-bun-1.2.1`                | ✅ ok   |
| `1.1.0`     | `control-bun-1.1.0`                | ✅ ok   |
| `1.0.0`     | `control-bun-1.0.0`                | ✅ ok   |

The version sweep runs only the Bun-specific cases. The Node runtime control stays in the default local repro because it does not vary by Bun version. I keep `1.2.0` out of the main matrix because it fails the controls too, which makes it noisy evidence for this specific bug.

For local reproduction, start with `bun run repro`.

[ANALYSIS.md](./ANALYSIS.md) has the source pointers and version notes.
