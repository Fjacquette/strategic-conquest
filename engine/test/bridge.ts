/**
 * Line-oriented JSON bridge used by the Python differential tests (tools/emu/jsbridge.py).
 *
 * Each input line is {"fn": name, "mem": base64 globals image, "args": [...]}; each output
 * line is {"result": value, "mem": base64 globals image, "log": [...]} or {"error": text}.
 */
import { createInterface } from "node:readline";
import { Mem } from "../src/mem.ts";
import { registry } from "./registry.ts";

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  let out: unknown;
  try {
    const req = JSON.parse(line);
    const fn = registry[req.fn];
    if (!fn) throw new Error(`unknown function ${req.fn}`);
    const m = new Mem(new Uint8Array(Buffer.from(req.mem, "base64")));
    const log: unknown[] = [];
    const result = fn(m, req.args ?? [], log);
    out = { result: result ?? null, mem: Buffer.from(m.u8).toString("base64"), log };
  } catch (e) {
    out = { error: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) };
  }
  process.stdout.write(JSON.stringify(out) + "\n");
});
