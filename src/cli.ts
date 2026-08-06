import { parseArgs, helpText } from "./args";
import { formatError, exitCodeFor } from "./errors";
import pkg from "../package.json" with { type: "json" };

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));

  if (parsed.flags.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  if (parsed.flags.help) {
    process.stdout.write(`${helpText(parsed.command)}\n`);
    return 0;
  }

  switch (parsed.command) {
    case "interactive": {
      const { runInteractive } = await import("./commands/interactive");
      return runInteractive(parsed);
    }
    case "build": {
      const { runBuild } = await import("./commands/build");
      return runBuild(parsed);
    }
    case "submit": {
      const { runSubmit } = await import("./commands/submit");
      return runSubmit(parsed);
    }
    case "deploy": {
      const { runDeploy } = await import("./commands/deploy");
      return runDeploy(parsed);
    }
    case "update": {
      const { runUpdate } = await import("./commands/update");
      return runUpdate(parsed);
    }
    case "run": {
      const { runLocal } = await import("./commands/run");
      return runLocal(parsed);
    }
    case "init": {
      const { runInit } = await import("./commands/init");
      return runInit(parsed);
    }
    case "doctor": {
      const { runDoctor } = await import("./commands/doctor");
      return runDoctor(parsed);
    }
    case "clean": {
      const { runClean } = await import("./commands/clean");
      return runClean(parsed);
    }
    case "vm": {
      const { runVm } = await import("./commands/vm");
      return runVm(parsed);
    }
    case "logs": {
      const { runLogs } = await import("./commands/logs");
      return runLogs(parsed);
    }
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`\n${formatError(err)}\n`);
    process.exit(exitCodeFor(err));
  });
