# Bun stdin/file-stream regression repro (NOW FIXED!)

> This repo is __historical evidence__ for [oven-sh/bun#30565](https://github.com/oven-sh/bun/issues/30565). Bun `1.3.14` resolves the stdin corruption reproduced here, and the upstream issue is closed.
>
> Keep this repository archived as a focused regression fixture. CI now asserts the fixed behavior on current `latest` and explicit Bun `1.3.14`; the older affected window remains documented for context.

The historical failure needed a specific order: Bun's Node-compatible `process.stdin` wrapper owned a TTY first, then `Bun.file(...).stream().getReader()` started for an unrelated regular file. After that, the next stdin read could close and destroy `process.stdin`. In a terminal UI, this looked like frozen keyboard input while the process stayed alive.

Reading a regular file should not make keyboard input look like EOF!

This took me about three weeks to completely pin down. The reduction ruled out renderer state, keyboard handling, raw mode, mouse handling, app state, file contents, file size, lazy path opening, Node/Web stream behavior, and ordinary fd0 HUP/ERR cases. What was left is the stdin-wrapper plus BunFile-reader interaction shown here.

## Minimal shape

```ts
process.stdin.on("readable", () => {});
void Bun.file(filePath).stream().getReader();
// send one line through the TTY
```

Expected: stdin stays readable after it receives the line.

Observed with Bun `1.3.13+bf2e2cecf`: stdin emitted `end` and `close`, then reported `closed=true`, `destroyed=true`, and `readable=false`.

Verified fixed with Bun `1.3.14`: all Bun-specific cases stay green in `--assert-fixed` mode.

## Run it

```bash
bun run repro
```

The runner allocates a real PTY from TypeScript using `openpty(3)` through `bun:ffi`. It sends one input line to each case and writes summaries under `artifacts/`.

Bun `1.3.14` produces this matrix:

| Case                | Status | Changed variable                             | Stdin state   | Takeaway                        |
| ------------------- | ------ | -------------------------------------------- | ------------- | ------------------------------- |
| `red`               | ✅ ok  | Bun file reader starts after stdin ownership | open/readable | Fixed minimal interaction.      |
| delayed fd poll     | ✅ ok  | Same case, with fd 0 polled before read      | open/readable | Fixed delayed-read interaction. |
| Node-backed stream  | ✅ ok  | Use `Readable.toWeb(createReadStream(...))`  | open/readable | Points at Bun native streams.   |
| reader before stdin | ✅ ok  | Start Bun file reader before stdin ownership | open/readable | Order matters.                  |
| immediate cancel    | ✅ ok  | Cancel Bun file reader immediately           | open/readable | Active reader matters.          |
| suppressed `_read`  | ✅ ok  | Suppress the post-push stdin `_read`         | open/readable | Close happens on later `_read`. |
| Node runtime        | ✅ ok  | Run the Node-backed control under Node       | open/readable | Bun-specific in this repro.     |

In the historical delayed diagnostic failure, fd 0 did not report `POLLHUP`, `POLLERR`, or `POLLNVAL` immediately before the read that closed stdin.

The terminal fd was still real, the byte was delivered, and the wrapper pushed it. The close happened on the next stdin wrapper read after the unrelated Bun file reader had started.

## Historical Bun source lead

The JS wrapper closed stdin after `reader.read()` returned done in [`src/js/builtins/ProcessObjectInternals.ts`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ProcessObjectInternals.ts#L222-L238). The suspicious edge was native stream state shared below the JS wrappers: `Bun.stdin.stream()` and file-backed `ReadableStream.fromNative(...)`.

The upstream fix landed in Bun `1.3.14`. The relevant invariant remains useful for future regressions: a regular-file Blob reader must leave fd 0's native stdin source EOF state alone. If the native layer returns done to the stdin reader, that done state must be traceable to stdin's own native source.

## Quality checks

```bash
bun install
bun run check
```

`bun run check` runs strict TypeScript, oxlint with warnings denied, and oxfmt in check mode.

## CI

GitHub Actions runs quality checks on latest Bun, then runs the repro in "assert fixed" mode against current `latest` and explicit Bun `1.3.14`:

```yaml
- uses: oven-sh/setup-bun@v2
  with:
    bun-version: latest
- run: bun run repro:assert-fixed
```

That mode expects every case to stay green. If the regression returns, the matrix entry fails, prints GitHub error annotations for the red cases, writes a job summary table, and uploads the JSON summaries as artifacts.

| Bun version | CI label                        | Status  |
| ----------- | ------------------------------- | ------- |
| `latest`    | `fixed-latest-currently-1.3.14` | ✅ ok   |
| `1.3.14`    | `fixed-bun-1.3.14`              | ✅ ok   |
| `1.3.13`    | `affected-bun-1.3.13`           | ❌ fail |
| `1.3.0`     | `affected-bun-1.3.0`            | ❌ fail |
| `1.2.23`    | `affected-bun-1.2.23`           | ❌ fail |
| `1.2.22`    | `affected-bun-1.2.22`           | ❌ fail |
| `1.2.21`    | `control-bun-1.2.21`            | ✅ ok   |
| `1.2.20`    | `control-bun-1.2.20`            | ✅ ok   |
| `1.2.10`    | `control-bun-1.2.10`            | ✅ ok   |
| `1.2.5`     | `control-bun-1.2.5`             | ✅ ok   |
| `1.2.1`     | `control-bun-1.2.1`             | ✅ ok   |
| `1.1.0`     | `control-bun-1.1.0`             | ✅ ok   |
| `1.0.0`     | `control-bun-1.0.0`             | ✅ ok   |

The historical affected/control rows are no longer in CI because this repository is archival. Re-introduce them only when investigating a new regression boundary. The version sweep runs only the Bun-specific cases. The Node runtime control stays in the default local repro because it does not vary by Bun version. I keep `1.2.0` out of the historical matrix because it fails the controls too, which makes it noisy evidence for this specific bug.

For local reproduction, start with `bun run repro`.

[ANALYSIS.md](./ANALYSIS.md) has the source pointers and version notes.
