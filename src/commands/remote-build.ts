import { spawn, spawnSync, execFileSync } from "child_process";
import { appendFileSync, mkdirSync, readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";
import * as p from "@clack/prompts";
import type { Platform, Profile } from "../args";
import { BuildError } from "../errors";
import { type ResolvedConfig, remotePaths, readExpoSdkRange } from "../config";
import {
  ssh, sshTargetString, pickSshKey, normalizedKeyCopy, toRsyncPath,
  findCwrsyncSsh, loginWrap, type SshTarget,
} from "../remote/ssh";
import { resolveWorkspaceDeps, computeSyncRoots, collectFiles, buildRsyncArgs } from "../remote/sync";
import { generateVmScript } from "../remote/vm-script";
import { generateHostScript } from "../remote/host-script";
import { parseMarker } from "../remote/markers";
import { OutputFilter, showLine, showBar } from "../ui/output";
import { PhaseTracker } from "../ui/phases";
import { inspectMac, planCleanup, applyCleanup } from "./clean";
import { assessPreflight } from "./preflight";
import { loadCompatTags } from "../compat-cache";
import { resolveImage, parseSdkMajor, compareVersions, requirementsFor } from "../compat";

export interface RemoteBuildOptions {
  cfg: ResolvedConfig;
  profile: Profile;
  platform: Platform;
  submit: boolean;
  optimize: boolean;
  cache: boolean;
  dryRun: boolean;
  download?: string;
}

function computeMobileRel(cfg: ResolvedConfig): string {
  return resolve(cfg.mobileDir)
    .slice(resolve(cfg.projectRoot).length)
    .replace(/\\/g, "/")
    .replace(/^\//, "");
}

export async function runRemoteBuild(opts: RemoteBuildOptions): Promise<number> {
  const { cfg, profile, platform, submit, optimize, cache, dryRun } = opts;
  const target: SshTarget = { host: cfg.mac.host, user: cfg.mac.user };
  const paths = remotePaths(cfg.slug);
  const platforms: ("android" | "ios")[] =
    platform === "all" ? ["ios", "android"] : [platform];

  if (!cfg.expoToken && !dryRun) {
    throw new BuildError(
      "EXPO_TOKEN is not set.",
      "Create one at expo.dev → Account Settings → Access Tokens, then set it in your\n" +
      "environment, the project's .env, or ~/.expo-builder/env",
    );
  }

  // ── Image compatibility (cached; never blocks on the network) ────────
  if (!dryRun) {
    const sdkRange = readExpoSdkRange(cfg.mobileDir);
    const sdkMajor = sdkRange ? parseSdkMajor(sdkRange) : undefined;
    const compat = await loadCompatTags();
    const resolved = resolveImage(sdkMajor, compat.tags, cfg.vm.xcode);

    const recordJson = ssh(target, `cat ${paths.imageRecord} 2>/dev/null || true`, { allowFailure: true });
    let record: { tag: string; xcode: string } | undefined;
    try { record = recordJson ? JSON.parse(recordJson) : undefined; } catch { /* absent */ }

    const req = sdkMajor === undefined ? undefined : requirementsFor(sdkMajor);
    if (record && req && compareVersions(record.xcode, req.minXcode) < 0) {
      throw new BuildError(
        `The VM image has Xcode ${record.xcode}, but Expo SDK ${sdkMajor} requires ${req.minXcode} or newer.`,
        `Rebuild the image:\n\n  expo-builder vm rebuild${resolved.tag ? ` --xcode ${resolved.tag}` : ""}`,
      );
    }
    if (record && resolved.tag && compareVersions(record.tag, resolved.tag) !== 0) {
      p.log.warn(
        `A better-matching image is available: Xcode ${resolved.tag} (currently ${record.tag}). ` +
        `Run: expo-builder vm rebuild`,
      );
    }
  }

  // ── Preflight ────────────────────────────────────────────────────────
  if (!dryRun) {
    const s = p.spinner();
    s.start("Checking disk space on the Mac...");
    const inputs = await inspectMac(target, cfg.slug, cfg.cache.budgetGB, false);
    const plan = planCleanup(inputs);
    const freeRaw = ssh(target, 'df -k "${TART_HOME:-$HOME}" | tail -1 | awk \'{print $4}\'', { allowFailure: true });
    const freeBytes = (parseInt(freeRaw, 10) || 0) * 1024;
    const verdict = assessPreflight({ freeBytes, reclaimableBytes: plan.reclaimableBytes });

    if (verdict.action === "refuse") {
      s.stop("Not enough disk space");
      throw new BuildError(verdict.message!);
    }
    if (verdict.action === "clean-then-proceed") {
      s.message(verdict.message!);
      await applyCleanup(target, cfg.slug, plan);
    }
    s.stop("Disk space OK");
  }

  // ── Sync ─────────────────────────────────────────────────────────────
  const workspaceDeps = resolveWorkspaceDeps(cfg.projectRoot, cfg.mobileDir);
  const roots = computeSyncRoots({
    projectRoot: cfg.projectRoot,
    mobileDir: cfg.mobileDir,
    workspaceDeps,
    syncPaths: cfg.syncPaths,
  });
  const files = collectFiles(cfg.projectRoot, roots);

  if (dryRun) {
    p.log.info(`Would sync ${files.length} files from: ${roots.join(", ")}`);
  } else {
    const s = p.spinner();
    s.start(`Syncing ${files.length} files to the Mac...`);

    const keyPath = pickSshKey({ configured: cfg.mac.sshKey });
    if (!keyPath) {
      throw new BuildError(
        "No SSH key found.",
        "Looked in ~/.ssh for id_ed25519, id_rsa, id_ecdsa.\n" +
        "Specify one with --ssh-key, or set mac.sshKey in expo-builder.json.",
      );
    }
    const usableKey = normalizedKeyCopy(keyPath, join(homedir(), ".expo-builder", "ssh"));

    const sshCommand = process.platform === "win32"
      ? `${toRsyncPath(findCwrsyncSsh())} -i ${toRsyncPath(usableKey)} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`
      : `ssh -i ${usableKey} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;

    ssh(target, `mkdir -p ${paths.project} ${paths.cache} ${paths.artifacts}`);

    const remoteRsync = ssh(
      target,
      "[ -x /opt/homebrew/bin/rsync ] && echo /opt/homebrew/bin/rsync || true",
      { allowFailure: true },
    );

    const result = spawnSync("rsync", buildRsyncArgs({
      sshCommand,
      source: `${toRsyncPath(cfg.projectRoot)}/`,
      destination: `${sshTargetString(target)}:${paths.project.replace("$HOME", "~")}/`,
      remoteRsyncPath: remoteRsync || undefined,
    }), {
      cwd: cfg.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      input: `${files.join("\n")}\n`,
    });

    if (result.status !== 0) {
      s.stop("rsync failed");
      throw new BuildError(
        `rsync exited with code ${result.status}`,
        result.stderr?.toString().trim(),
      );
    }
    s.stop(`Synced ${files.length} files`);

    if (optimize) {
      const here = dirname(fileURLToPath(import.meta.url));
      const candidates = [
        resolve(here, "..", "..", "plugins", "withBuildOptimizations.js"),
        resolve(here, "..", "plugins", "withBuildOptimizations.js"),
      ];
      const pluginSrc = candidates.find((c) => existsSync(c));
      if (pluginSrc) {
        const mobileRel = computeMobileRel(cfg);
        const dest = mobileRel
          ? `${paths.project}/${mobileRel}/plugins/withBuildOptimizations.js`
          : `${paths.project}/plugins/withBuildOptimizations.js`;
        spawnSync("ssh", [sshTargetString(target), `mkdir -p "$(dirname ${dest})" && cat > ${dest}`], {
          stdio: ["pipe", "pipe", "pipe"],
          input: readFileSync(pluginSrc, "utf-8"),
        });
      }
    }
  }

  // ── Build each platform ──────────────────────────────────────────────
  for (let i = 0; i < platforms.length; i++) {
    const plat = platforms[i]!;
    const label = platforms.length > 1 ? ` [${i + 1}/${platforms.length}]` : "";
    p.log.step(`${submit ? "Build + Submit" : "Build"}: ${plat} (${profile})${label}`);

    const timestamp = Date.now();
    const vmScript = generateVmScript({
      expoToken: cfg.expoToken ?? "",
      profile,
      platform: plat,
      submit,
      optimize,
      cacheEnabled: cache && cfg.cache.enabled,
      mountName: cfg.slug,
      mobileRelPath: computeMobileRel(cfg),
      javaVersion: "17",
    });

    const stateFile = `/tmp/expo-builder-vm-${cfg.slug}-${timestamp}-${i}`;
    // Keep the $HOME form: the host script uses this inside double quotes,
    // where "~" would not expand but "$HOME" does.
    const artifactDir = `${paths.artifacts}/${timestamp}`;
    const hostScript = generateHostScript({
      imageName: cfg.vm.name,
      mountName: cfg.slug,
      remotePath: paths.project,
      cachePath: cache && cfg.cache.enabled ? paths.cache : undefined,
      artifactDir,
      artifactExt: plat === "ios" ? "ipa" : "aab",
      stateFile,
      vmScript,
      timestamp,
      tartHome: cfg.mac.tartHome,
    });

    if (dryRun) {
      process.stdout.write(`\n===== Mac host script (${plat}) =====\n${hostScript}\n`);
      process.stdout.write(`\n===== VM script (${plat}) =====\n${vmScript}\n`);
      continue;
    }

    const exitCode = await streamRemoteScript({
      target, hostScript, stateFile, plat, profile,
      projectRoot: cfg.projectRoot, slug: cfg.slug, timestamp,
    });

    if (exitCode !== 0) {
      throw new BuildError(`Remote build failed (${plat}, ${profile})`);
    }
    p.log.success(`${plat} ${submit ? "built and submitted" : "build complete"}`);
  }

  return 0;
}

interface StreamOptions {
  target: SshTarget;
  hostScript: string;
  stateFile: string;
  plat: string;
  profile: string;
  projectRoot: string;
  slug: string;
  timestamp: number;
}

/**
 * Push the host script to the Mac, run it, and translate marker output into
 * spinners. No PTY: -tt puts the local terminal into raw mode and breaks
 * spinner rendering.
 */
async function streamRemoteScript(opts: StreamOptions): Promise<number> {
  const { target, hostScript, stateFile, plat, profile, projectRoot, timestamp } = opts;
  const targetStr = sshTargetString(target);
  const scriptPath = `/tmp/expo-builder-build-${opts.slug}-${timestamp}.sh`;

  spawnSync("ssh", [targetStr, `cat > ${scriptPath} && chmod +x ${scriptPath}`], {
    stdio: ["pipe", "pipe", "pipe"],
    input: hostScript,
  });

  const logDir = resolve(projectRoot, "logs");
  mkdirSync(logDir, { recursive: true });
  const logFile = resolve(
    logDir,
    `${plat}-${profile}-${new Date(timestamp).toISOString().replace(/[:.]/g, "-")}.log`,
  );
  const log = (text: string) => appendFileSync(logFile, `${text}\n`);

  return new Promise<number>((done, fail) => {
    const child = spawn("ssh", [targetStr, `bash ${scriptPath}; rm -f ${scriptPath}`], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const phases = new PhaseTracker();
    const filter = new OutputFilter();
    let failed = false;
    let hadOutput = false;
    let easPhase = "";

    const flushBar = () => { if (hadOutput) { showBar(); hadOutput = false; } };

    const processLine = (line: string, isStderr = false) => {
      log(line);
      filter.record(line);

      const marker = parseMarker(line);
      if (marker) {
        switch (marker.kind) {
          case "phase":
            phases.start(marker.value, marker.value === "build" ? `Building ${plat} (${profile})...` : undefined);
            easPhase = "";
            return;
          case "boot-wait": flushBar(); phases.message(`Booting VM... (${marker.value}s)`); return;
          case "vm-ip": flushBar(); phases.message(`VM booted (${marker.value})`); return;
          case "vm-resources": showLine(`VM: ${marker.value}`); hadOutput = true; return;
          case "version": flushBar(); phases.message(`Version: ${marker.value}`); return;
          case "stale": showLine(`Removing stale VM: ${marker.value}`); hadOutput = true; return;
          case "image-size": showLine(`Image: ${marker.value}`); hadOutput = true; return;
          case "error":
            phases.stop(false);
            failed = true;
            p.log.error(marker.value);
            return;
        }
      }

      if (isStderr) { showLine(line); hadOutput = true; return; }

      const verdict = filter.classify(line, phases.current);
      if (verdict !== "show") return;

      if (phases.current === "build") {
        const sub = filter.easPhase(line);
        if (sub && sub !== easPhase) {
          flushBar();
          easPhase = sub;
          phases.message(`Building ${plat}: ${sub}`);
        }
      }
      showLine(line);
      hadOutput = true;
    };

    const makeReader = (isStderr: boolean) => {
      let buf = "";
      return (chunk: Buffer) => {
        buf += chunk.toString();
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const raw of parts) {
          const line = raw.replace(/\r/g, "").trim();
          if (line) processLine(line, isStderr);
        }
      };
    };

    child.stdout!.on("data", makeReader(false));
    child.stderr!.on("data", makeReader(true));

    let interrupted = false;
    const onSignal = () => {
      if (interrupted) return;
      interrupted = true;
      phases.stop(false);
      p.log.warn("Interrupted — cleaning up the VM on the Mac...");
      try {
        execFileSync("ssh", ["-o", "ConnectTimeout=15", targetStr, loginWrap(
          `VM=$(cat ${stateFile} 2>/dev/null); ` +
          `[ -n "$VM" ] && tart stop -t 30 "$VM" 2>/dev/null; ` +
          `[ -n "$VM" ] && tart delete "$VM" 2>/dev/null; ` +
          `rm -f ${stateFile} ${scriptPath}`,
        )], { stdio: "pipe", timeout: 60000 });
        p.log.info("VM cleaned up");
      } catch {
        p.log.warn("Could not confirm VM cleanup — the next build will sweep it");
      }
      child.kill("SIGTERM");
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.on("SIGHUP", onSignal);

    child.on("close", (code) => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.off("SIGHUP", onSignal);
      phases.stop(!failed && code === 0);
      if (failed || code !== 0) {
        p.log.message("Last output:");
        for (const l of filter.tail().slice(-15)) process.stdout.write(`│  ${l}\n`);
        showBar();
      }
      p.log.info(`Log: ${logFile}`);
      done(code ?? 1);
    });
    child.on("error", fail);
  });
}
