#!/usr/bin/env bun
import { dlopen, ptr, suffix } from "bun:ffi";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

type CaseName =
  | "after-order-control"
  | "delay-fd-diagnostic"
  | "immediate-cancel-control"
  | "node-web-control"
  | "red"
  | "suppress-post-push-diagnostic";

type StdinWithInternals = NodeJS.ReadStream & {
  _read(size: number): void;
  push(chunk: Uint8Array | string | null, encoding?: BufferEncoding): boolean;
};

interface MethodEvent {
  readonly method: "_read" | "_read-delayed" | "_read-suppressed" | "destroy" | "push";
  readonly ms: number;
  readonly size?: number;
  readonly valueLength?: number | null;
}

interface FdProbe {
  readonly pollResult: number;
  readonly revents: number;
  readonly readable: boolean;
  readonly hup: boolean;
  readonly err: boolean;
  readonly nval: boolean;
}

const pollSymbols = {
  poll: { args: ["ptr", process.platform === "darwin" ? "u32" : "usize", "i32"], returns: "i32" },
} as const;

interface CancelableReader {
  cancel(): Promise<void>;
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(name);
  if (index < 0) return null;
  const value = Bun.argv[index + 1];
  if (value === undefined || value.length === 0) throw new Error(`Missing value after ${name}`);
  return value;
}

function parseCase(raw: string | null): CaseName {
  if (raw === null) return "red";
  if (
    raw === "after-order-control" ||
    raw === "delay-fd-diagnostic" ||
    raw === "immediate-cancel-control" ||
    raw === "node-web-control" ||
    raw === "red" ||
    raw === "suppress-post-push-diagnostic"
  ) {
    return raw;
  }
  throw new Error(`Unsupported --case ${raw}`);
}

function snapshotStdin(): Record<string, unknown> {
  return {
    closed: process.stdin.closed,
    destroyed: process.stdin.destroyed,
    isTTY: process.stdin.isTTY,
    readable: process.stdin.readable,
    readableEnded: process.stdin.readableEnded,
    readableFlowing: process.stdin.readableFlowing,
    readableLength: process.stdin.readableLength,
  };
}

function pollFd0(): FdProbe {
  const candidates =
    process.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : [`libc.${suffix}`, "libc.so.6"];
  let lib: ReturnType<typeof dlopen<typeof pollSymbols>> | undefined;
  for (const candidate of candidates) {
    try {
      lib = dlopen(candidate, pollSymbols);
      break;
    } catch {}
  }
  if (lib === undefined) throw new Error(`Cannot load poll(2) on ${process.platform}`);

  const buffer = new Uint8Array(8);
  const view = new DataView(buffer.buffer);
  view.setInt32(0, 0, true);
  view.setInt16(4, 0x0001 | 0x0008 | 0x0010, true);
  const pollResult = lib.symbols.poll(ptr(buffer), 1, 0);
  lib.close();
  const revents = view.getInt16(6, true);
  return {
    err: (revents & 0x0008) !== 0,
    hup: (revents & 0x0010) !== 0,
    nval: (revents & 0x0020) !== 0,
    pollResult,
    readable: (revents & 0x0001) !== 0,
    revents,
  };
}

function attachReadableOwnership(counter: { readableEvents: number }): void {
  process.stdin.on("readable", () => {
    counter.readableEvents += 1;
  });
}

function attachPostPushProbe(
  mode: "delay-fd" | "suppress",
  events: MethodEvent[],
  fdProbes: FdProbe[],
  startMs: number,
): void {
  const stdin: StdinWithInternals = process.stdin;
  const originalDestroy = stdin.destroy.bind(stdin);
  const originalPush = stdin.push.bind(stdin);
  const originalRead = stdin._read.bind(stdin);
  let sawValuePush = false;

  stdin._read = (size) => {
    if (sawValuePush && mode === "suppress") {
      events.push({
        method: "_read-suppressed",
        ms: Math.round(performance.now() - startMs),
        size,
      });
      return;
    }
    if (sawValuePush && mode === "delay-fd") {
      events.push({ method: "_read-delayed", ms: Math.round(performance.now() - startMs), size });
      setTimeout(() => {
        fdProbes.push(pollFd0());
        originalRead(size);
      }, 500);
      return;
    }
    events.push({ method: "_read", ms: Math.round(performance.now() - startMs), size });
    originalRead(size);
  };

  stdin.push = (chunk, encoding) => {
    if (chunk !== null) sawValuePush = true;
    events.push({
      method: "push",
      ms: Math.round(performance.now() - startMs),
      valueLength: chunk === null ? null : Buffer.byteLength(chunk),
    });
    return originalPush(chunk, encoding);
  };

  stdin.destroy = (error) => {
    events.push({ method: "destroy", ms: Math.round(performance.now() - startMs) });
    return originalDestroy(error);
  };
}

function startBunFileReader(fixturePath: string): CancelableReader {
  return Bun.file(fixturePath).stream().getReader();
}

const caseName = parseCase(flag("--case"));
const outDir = flag("--out") ?? join(process.cwd(), "artifacts", caseName);
mkdirSync(outDir, { recursive: true });

if (!process.stdin.isTTY) throw new Error("Run through a PTY, for example: bun run repro");

const fixturePath = join(outDir, "fixture.jsonl");
const summaryPath = join(outDir, "summary.json");
writeFileSync(fixturePath, `${JSON.stringify({ id: 1, text: "fixture" })}\n`);

const startMs = performance.now();
const counters = { readableEvents: 0 };
const fdProbes: FdProbe[] = [];
const lifecycleEvents: string[] = [];
const methodEvents: MethodEvent[] = [];

process.stdin.on("end", () => lifecycleEvents.push("end"));
process.stdin.on("close", () => lifecycleEvents.push("close"));

if (caseName === "delay-fd-diagnostic")
  attachPostPushProbe("delay-fd", methodEvents, fdProbes, startMs);
if (caseName === "suppress-post-push-diagnostic")
  attachPostPushProbe("suppress", methodEvents, fdProbes, startMs);

if (caseName !== "after-order-control") attachReadableOwnership(counters);

if (caseName === "node-web-control") {
  void Readable.toWeb(createReadStream(fixturePath)).getReader();
} else if (caseName === "immediate-cancel-control") {
  await startBunFileReader(fixturePath).cancel();
} else {
  startBunFileReader(fixturePath);
}

if (caseName === "after-order-control") attachReadableOwnership(counters);

process.stdout.write(`READY ${caseName}: send one canonical line. summary=${summaryPath}\n`);
await Bun.sleep(1_200);

const final = snapshotStdin();
const reason =
  final.closed === true || final.destroyed === true || final.readable === false ? "red" : "green";
writeFileSync(
  summaryPath,
  `${JSON.stringify(
    {
      bun: Bun.version,
      caseName,
      counters,
      fdProbes,
      final,
      lifecycleEvents,
      methodEvents,
      reason,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`summary=${summaryPath}\n`);
process.exit(reason === "red" ? 1 : 0);
