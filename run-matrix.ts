#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

interface CaseSpec {
  readonly name: string;
  readonly command: readonly string[];
  readonly expect: "green" | "red";
  readonly changed: string;
  readonly includeInVersionSweep?: boolean;
  readonly summary: string;
}

interface Summary {
  readonly reason: "green" | "red";
  readonly final: {
    readonly closed?: boolean;
    readonly destroyed?: boolean;
    readonly readable?: boolean;
  };
}

interface MatrixResult {
  readonly actual: "green" | "missing" | "red";
  readonly closed?: boolean;
  readonly destroyed?: boolean;
  readonly expected: "green" | "red";
  readonly changed: string;
  readonly meaning: string;
  readonly name: string;
  readonly matchesExpectation: boolean;
  readonly readable?: boolean;
}

function assertionMeaning(spec: CaseSpec, expected: "green" | "red"): string {
  if (expected === "green" && spec.expect === "red") {
    return "Regression sentinel: this historically failed when the Bun native file reader corrupted stdin, and must now stay green.";
  }
  return spec.summary;
}

function addIfDefined<T extends object, K extends PropertyKey, V>(
  target: T,
  key: K,
  value: V | undefined,
): T & Partial<Record<K, V>> {
  if (value !== undefined) Object.assign(target, { [key]: value });
  return target;
}

function runInPty(command: readonly string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, ["pty-runner.ts", ...command], {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function outputText(value: string | Buffer | null | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function readSummary(path: string): Summary {
  return JSON.parse(readFileSync(path, "utf8")) as Summary;
}

function stdinState(row: MatrixResult): string {
  if (row.actual === "missing") return "missing summary";
  if (row.closed === true || row.destroyed === true || row.readable === false) {
    return "closed/destroyed";
  }
  return "open/readable";
}

const root = process.cwd();
const assertFixed = process.argv.includes("--assert-fixed");
const artifactsRoot = join(root, "artifacts");
const runId =
  process.env.REPRO_RUN_ID ??
  `${assertFixed ? "assert-fixed" : "current"}-${Date.now()}-${process.pid}`;
const artifacts = join(artifactsRoot, runId);
rmSync(artifacts, { force: true, recursive: true });
mkdirSync(artifacts, { recursive: true });

const cases: readonly CaseSpec[] = [
  {
    name: "red",
    command: [
      process.execPath,
      "bun-stdin-bun-file-stream-repro.ts",
      "--case",
      "red",
      "--out",
      join(artifacts, "red"),
    ],
    expect: "red",
    changed: "Bun file reader starts after stdin ownership",
    summary: "Reproduces the failing interaction.",
  },
  {
    name: "delay-fd-diagnostic",
    command: [
      process.execPath,
      "bun-stdin-bun-file-stream-repro.ts",
      "--case",
      "delay-fd-diagnostic",
      "--out",
      join(artifacts, "delay-fd-diagnostic"),
    ],
    expect: "red",
    changed: "Same as red, with delayed fd 0 poll before fatal read",
    summary: "Rules out immediate fd 0 HUP/ERR/NVAL as the cause.",
  },
  {
    name: "node-web-control",
    command: [
      process.execPath,
      "bun-stdin-bun-file-stream-repro.ts",
      "--case",
      "node-web-control",
      "--out",
      join(artifacts, "node-web-control"),
    ],
    expect: "green",
    changed: "Node-backed file stream replaces Bun.file(...).stream()",
    summary: "Points at Bun's native file-backed stream path.",
  },
  {
    name: "after-order-control",
    command: [
      process.execPath,
      "bun-stdin-bun-file-stream-repro.ts",
      "--case",
      "after-order-control",
      "--out",
      join(artifacts, "after-order-control"),
    ],
    expect: "green",
    changed: "Bun file reader starts before stdin ownership",
    summary: "Shows ordering of stdin ownership and file reader startup matters.",
  },
  {
    name: "immediate-cancel-control",
    command: [
      process.execPath,
      "bun-stdin-bun-file-stream-repro.ts",
      "--case",
      "immediate-cancel-control",
      "--out",
      join(artifacts, "immediate-cancel-control"),
    ],
    expect: "green",
    changed: "Bun file reader is cancelled immediately",
    summary: "Shows an active native file reader is part of the trigger.",
  },
  {
    name: "suppress-post-push-diagnostic",
    command: [
      process.execPath,
      "bun-stdin-bun-file-stream-repro.ts",
      "--case",
      "suppress-post-push-diagnostic",
      "--out",
      join(artifacts, "suppress-post-push-diagnostic"),
    ],
    expect: "green",
    changed: "Post-push stdin _read is suppressed",
    summary: "Places the close on the later stdin wrapper read.",
  },
  {
    name: "node-runtime-control",
    command: [
      "node",
      "node-stdin-node-web-control.mjs",
      "--out",
      join(artifacts, "node-runtime-control"),
    ],
    expect: "green",
    changed: "Same Node-backed stream check under Node",
    includeInVersionSweep: false,
    summary: "Confirms Node itself does not reproduce this case.",
  },
];

let failed = false;
const results: MatrixResult[] = [];
for (const spec of cases.filter((item) => !assertFixed || item.includeInVersionSweep !== false)) {
  const result = runInPty(spec.command);
  const summaryPath = join(artifacts, spec.name, "summary.json");
  const expected = assertFixed ? "green" : spec.expect;
  const meaning = assertionMeaning(spec, expected);
  if (!existsSync(summaryPath)) {
    failed = true;
    results.push({
      actual: "missing",
      changed: spec.changed,
      expected,
      meaning,
      name: spec.name,
      matchesExpectation: false,
    });
    process.stdout.write(`::error title=${spec.name} missing summary::exit=${result.status}\n`);
    process.stdout.write(
      `${spec.name}: missing summary exit=${result.status}\n${outputText(result.stdout)}${outputText(result.stderr)}\n`,
    );
    continue;
  }

  const summary = readSummary(summaryPath);
  const matchesExpectation = summary.reason === expected;
  failed ||= !matchesExpectation;
  const row: MatrixResult = {
    actual: summary.reason,
    changed: spec.changed,
    expected,
    meaning,
    name: spec.name,
    matchesExpectation,
  };
  addIfDefined(row, "closed", summary.final.closed);
  addIfDefined(row, "destroyed", summary.final.destroyed);
  addIfDefined(row, "readable", summary.final.readable);
  results.push(row);
  if (!matchesExpectation) {
    process.stdout.write(
      `::error title=${spec.name} reproduced bug::expected=${expected} actual=${summary.reason} closed=${String(summary.final.closed)} destroyed=${String(summary.final.destroyed)} readable=${String(summary.final.readable)}\n`,
    );
  }
  process.stdout.write(
    [
      spec.name,
      `expect=${expected}`,
      `actual=${summary.reason}`,
      `closed=${String(summary.final.closed)}`,
      `destroyed=${String(summary.final.destroyed)}`,
      `readable=${String(summary.final.readable)}`,
      matchesExpectation ? "matched-expectation" : "FAILED-expectation",
    ].join(" ") + "\n",
  );
}

writeFileSync(
  join(artifacts, "matrix-summary.json"),
  `${JSON.stringify({ assertFixed, bun: Bun.version, results }, null, 2)}\n`,
);
process.stdout.write(`bun=${Bun.version}\nartifacts=${artifacts}\n`);

const githubStepSummary = process.env.GITHUB_STEP_SUMMARY;
if (githubStepSummary !== undefined && githubStepSummary.length > 0) {
  appendFileSync(githubStepSummary, `# Bun stdin/file-stream repro\n\n`);
  appendFileSync(githubStepSummary, `Bun runtime: \`${Bun.version}\`\n\n`);
  appendFileSync(
    githubStepSummary,
    `Mode: ${assertFixed ? "assert fixed" : "current bug matrix"}\n\n`,
  );
  appendFileSync(githubStepSummary, `Artifacts: \`${artifacts}\`\n\n`);
  appendFileSync(
    githubStepSummary,
    `| Case | Changed variable | Stdin after one TTY line | What this shows | Assertion |\n`,
  );
  appendFileSync(githubStepSummary, `| --- | --- | --- | --- | --- |\n`);
  for (const row of results) {
    appendFileSync(
      githubStepSummary,
      `| ${row.name} | ${row.changed} | ${stdinState(row)} | ${row.meaning} | ${row.matchesExpectation ? "matched" : "failed"} |\n`,
    );
  }
}

process.exit(failed ? 1 : 0);
