#!/usr/bin/env bun
import { dlopen, ptr, suffix } from "bun:ffi";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, createReadStream, writeSync } from "node:fs";

interface OpenPtyResult {
  readonly master: number;
  readonly slave: number;
}

const openPtySymbols = {
  openpty: { args: ["ptr", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
} as const;

function openPty(): OpenPtyResult {
  const candidates =
    process.platform === "darwin"
      ? ["/usr/lib/libSystem.B.dylib"]
      : [`libutil.${suffix}`, "libutil.so.1", `libc.${suffix}`, "libc.so.6"];
  let lib: ReturnType<typeof dlopen<typeof openPtySymbols>> | undefined;
  for (const candidate of candidates) {
    try {
      lib = dlopen(candidate, openPtySymbols);
      break;
    } catch {}
  }
  if (lib === undefined) throw new Error(`Cannot load openpty(3) on ${process.platform}`);

  const masterBuffer = new Uint8Array(4);
  const slaveBuffer = new Uint8Array(4);
  const rc = lib.symbols.openpty(ptr(masterBuffer), ptr(slaveBuffer), null, null, null);
  lib.close();
  if (rc !== 0) throw new Error(`openpty(3) failed with code ${rc}`);

  return {
    master: new DataView(masterBuffer.buffer).getInt32(0, true),
    slave: new DataView(slaveBuffer.buffer).getInt32(0, true),
  };
}

async function waitForExit(command: readonly string[]): Promise<number> {
  if (command.length === 0) throw new Error("usage: bun pty-runner.ts <command> [args...]");

  const [executable, ...args] = command;
  if (executable === undefined) throw new Error("missing executable");

  const { master, slave } = openPty();
  const child = spawn(executable, args, {
    stdio: [slave, slave, slave],
  });
  closeSync(slave);

  const stream = createReadStream("", { fd: master, autoClose: true });
  let sent = false;
  let output = "";

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
  }, 4_000);

  stream.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    process.stdout.write(text);
    if (!sent && output.includes("READY")) {
      writeSync(master, "j\n");
      sent = true;
    }
  });

  const exitPromise = once(child, "exit").then(([code]) => (typeof code === "number" ? code : 1));
  const errorPromise = once(child, "error").then(([error]) => {
    process.stderr.write(`${String(error)}\n`);
    child.kill("SIGTERM");
    return 1;
  });
  const code = await Promise.race([exitPromise, errorPromise]);
  clearTimeout(timeout);
  return code;
}

process.exit(await waitForExit(Bun.argv.slice(2)));
