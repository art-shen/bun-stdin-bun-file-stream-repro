#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`Missing value after ${name}`);
  return value;
}

function snapshotStdin() {
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

const outDir = flag("--out") ?? join(process.cwd(), "artifacts", "node-web-control");
mkdirSync(outDir, { recursive: true });

if (!process.stdin.isTTY) throw new Error("Run through a PTY, for example: bun run repro");

const fixturePath = join(outDir, "fixture.jsonl");
const summaryPath = join(outDir, "summary.json");
writeFileSync(fixturePath, `${JSON.stringify({ id: 1, text: "fixture" })}\n`);

let readableEvents = 0;
const lifecycleEvents = [];
process.stdin.on("readable", () => {
  readableEvents += 1;
});
process.stdin.on("end", () => lifecycleEvents.push("end"));
process.stdin.on("close", () => lifecycleEvents.push("close"));

void Readable.toWeb(createReadStream(fixturePath)).getReader();

process.stdout.write(`READY node-web-control: send one canonical line. summary=${summaryPath}\n`);
await new Promise((resolve) => setTimeout(resolve, 1_200));

const final = snapshotStdin();
const reason =
  final.closed === true || final.destroyed === true || final.readable === false ? "red" : "green";
writeFileSync(
  summaryPath,
  `${JSON.stringify(
    {
      node: process.version,
      caseName: "node-web-control",
      counters: { readableEvents },
      final,
      lifecycleEvents,
      reason,
    },
    null,
    2,
  )}\n`,
);
process.stdout.write(`summary=${summaryPath}\n`);
process.exit(reason === "red" ? 1 : 0);
