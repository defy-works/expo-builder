import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import * as p from "@clack/prompts";
import type { ParsedArgs } from "../args";
import { loadConfig } from "../config";

export async function runLogs(args: ParsedArgs): Promise<number> {
  const cfg = loadConfig({ cwd: process.cwd(), overrides: args.flags });
  const logDir = resolve(cfg.projectRoot, "logs");

  if (!existsSync(logDir)) {
    p.log.info("No logs yet. Run a remote build first.");
    return 0;
  }

  const files = readdirSync(logDir)
    .filter((f) => f.endsWith(".log"))
    .sort()
    .reverse();

  if (files.length === 0) {
    p.log.info("No logs yet.");
    return 0;
  }

  if (args.flags.last) {
    process.stdout.write(readFileSync(join(logDir, files[0]!), "utf-8"));
    return 0;
  }

  process.stdout.write(`${files.map((f) => join(logDir, f)).join("\n")}\n`);
  return 0;
}
