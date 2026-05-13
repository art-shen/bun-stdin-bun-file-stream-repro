# Analysis notes

These notes are only about the standalone repro and the Bun source paths I checked. They do not depend on any downstream app.

## Resolution

Bun `1.3.14` resolves this repro. The upstream report is [oven-sh/bun#30565](https://github.com/oven-sh/bun/issues/30565), and the repository should now be treated as archived historical evidence plus a regression fixture.

The active invariant for future checks is narrow: after `process.stdin` owns TTY stdin, starting an unrelated `Bun.file(...).stream().getReader()` must not make a later stdin wrapper read report EOF. `bun run repro:assert-fixed` is the local assertion for that invariant.

## Reduced behavior

The historical failing sequence was:

1. `process.stdin.on('readable', ...)` makes Bun's Node-compatible stdin wrapper own the underlying native stdin stream.
2. `Bun.file(filePath).stream().getReader()` starts a native Bun file-backed stream for an unrelated regular file.
3. One later TTY input line is delivered.
4. The stdin wrapper receives and pushes that line, then a later wrapper `_read` closes/destroys `process.stdin`.

The matrix rules out these explanations:

- Generic Web streams: Node-backed `Readable.toWeb(createReadStream(...))` stays green under Bun.
- Node behavior: the same check under Node stays green.
- File reader creation before stdin ownership: green.
- Immediate reader cancellation: green.
- First value delivery failure: the diagnostic sees `push(2)` before the red close.
- Same-turn reentrancy alone: delaying the post-push read by 500 ms still closes stdin.
- OS fd0 HUP/ERR/NVAL at the delayed read boundary: `poll(2)` reports none in the diagnostic red case.

## Bun source paths checked

Source tag: `bun-v1.3.13`.

Stdin wrapper path:

- [`src/bun.js/api/BunObject.zig:2091-2099`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/api/BunObject.zig#L2091-L2099) creates `Bun.stdin` as a Blob backed by the VM stdin store.
- [`src/bun.js/rare_data.zig:585-610`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/rare_data.zig#L585-L610) creates that stdin store as fd 0 file data.
- [`src/js/builtins/ProcessObjectInternals.ts:120`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ProcessObjectInternals.ts#L120) creates the native stdin stream with `Bun.stdin.stream()`.
- [`src/js/builtins/ProcessObjectInternals.ts:132`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ProcessObjectInternals.ts#L132) acquires `native.getReader()`.
- [`src/js/builtins/ProcessObjectInternals.ts:183-185`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ProcessObjectInternals.ts#L183-L185) calls `own()` when a `readable` listener is added.
- [`src/js/builtins/ProcessObjectInternals.ts:213-215`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ProcessObjectInternals.ts#L213-L215) calls `own()` from `resume()`.
- [`src/js/builtins/ProcessObjectInternals.ts:222-238`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ProcessObjectInternals.ts#L222-L238) awaits `reader.read()`, pushes values, emits `end`, and destroys stdin when no value is returned.

Bun file stream path:

- [`src/bun.js/api/BunObject.zig:20`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/api/BunObject.zig#L20) wires `Bun.file`.
- [`src/bun.js/webcore/Blob.zig:1896-1907`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/Blob.zig#L1896-L1907), [`2036-2040`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/Blob.zig#L2036-L2040), and [`2829-2848`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/Blob.zig#L2829-L2848) route file-backed Blob streams toward `ReadableStream.fromBlobCopyRef(...)`.
- [`src/bun.js/webcore/ReadableStream.zig:315-330`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/ReadableStream.zig#L315-L330) creates `webcore.FileReader.Source` for file-backed blobs.
- [`src/bun.js/webcore/ReadableStream.zig:534-545`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/ReadableStream.zig#L534-L545) wraps the native source with `ReadableStream.fromNative(...)`.
- [`src/js/builtins/ReadableStream.ts:84-98`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ReadableStream.ts#L84-L98) stores lazy native stream startup in the stream private `start` slot.
- [`src/js/builtins/ReadableStream.ts:380-391`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ReadableStream.ts#L380-L391) invokes that `start` slot from `getReader()` before returning the reader.
- [`src/js/builtins/ReadableStreamInternals.ts:2154-2170`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ReadableStreamInternals.ts#L2154-L2170) calls native `handle.start(autoAllocateChunkSize)`.

Cancel/read boundary:

- [`src/js/builtins/ReadableStreamDefaultReader.ts:36-42`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ReadableStreamDefaultReader.ts#L36-L42) delegates `reader.cancel()`.
- [`src/js/builtins/ReadableStreamInternals.ts:1592-1609`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ReadableStreamInternals.ts#L1592-L1609) delegates cancel to the stream.
- [`src/bun.js/webcore/ReadableStream.zig:468-474`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/ReadableStream.zig#L468-L474) marks the native source cancelled and invokes source cancellation.
- [`src/bun.js/webcore/FileReader.zig:287-292`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/FileReader.zig#L287-L292) marks file source cancellation as done.
- [`src/js/builtins/ReadableStreamInternals.ts:1709-1721`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/js/builtins/ReadableStreamInternals.ts#L1709-L1721) makes `reader.read()` call the stream controller pull hook.
- [`src/bun.js/webcore/FileReader.zig:494-504`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/FileReader.zig#L494-L504) starts a file reader when flowing and no read is pending.

Native reader/done path:

- [`src/bun.js/webcore/FileReader.zig:182-280`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/FileReader.zig#L182-L280) starts file-backed streams by opening the backing file and setting reader state.
- [`src/io/PipeReader.zig:111-113`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/io/PipeReader.zig#L111-L113) treats `is_done`, `received_eof`, or `closed_without_reporting` as done.
- [`src/io/PipeReader.zig:351-387`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/io/PipeReader.zig#L351-L387) makes pipe readers call `bun.isReadable(fd)` before reading.
- [`src/bun.zig:546-573`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.zig#L546-L573) implements zero-timeout `poll(2)` readiness and maps HUP/ERR.
- [`src/io/PipeReader.zig:450-525`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/io/PipeReader.zig#L450-L525) handles blocking pipe reads and EOF.
- [`src/bun.js/webcore/FileReader.zig:461-555`](https://github.com/oven-sh/bun/blob/bun-v1.3.13/src/bun.js/webcore/FileReader.zig#L461-L555) maps a done buffered reader to Web stream `done`.

## Scope

The repro covers one narrow interaction:

> If Bun's Node-compatible `process.stdin` wrapper owns TTY stdin before a native Bun file-backed stream reader starts, a later stdin wrapper read can close/destroy `process.stdin` after delivering one input line. Node-backed file streams, Node runtime behavior, reverse ownership order, and immediate Bun reader cancellation do not reproduce it.

The unresolved part is the lower native state transition that makes the stdin wrapper's later `reader.read()` return done after the unrelated BunFile reader starts.

## Resolved fix direction

The relevant investigation path was below `ProcessObjectInternals.ts`. That wrapper reacted to `reader.read()` returning done; the repro showed fd 0 still had no `POLLHUP`, `POLLERR`, or `POLLNVAL` immediately before the fatal read.

The invariant remains the important portable takeaway: a regular-file Blob reader must leave fd 0's stdin reader EOF/done state alone. If the stdin JS wrapper receives done, that done state should be traceable to stdin's own native source.

## Version sweep

The repro APIs work as far back as Bun `1.0.0`.

The stable-release boundary I can show is between `1.2.21` and `1.2.22`:

- `1.0.0`, `1.1.0`, `1.2.1`, `1.2.5`, `1.2.10`, `1.2.20`, and `1.2.21`: green in `--assert-fixed` mode.
- `1.2.22`, `1.2.23`, `1.3.0`, and `1.3.13`: red only for the narrow cases, with the controls green.
- `1.3.14`: green in `--assert-fixed` mode.

I also tried `1.2.0`, but it fails every stdin case, including controls. I am keeping it out of the main CI matrix because that looks like a broader historical stdin issue, not clean evidence for this bug.
