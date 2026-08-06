import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { BuildError } from "../errors";

export interface PickKeyOptions {
  override?: string;
  configured?: string;
  sshDir?: string;
}

const KEY_CANDIDATES = ["id_ed25519", "id_rsa", "id_ecdsa"];

export function pickSshKey(opts: PickKeyOptions = {}): string | undefined {
  const sshDir = opts.sshDir ?? join(homedir(), ".ssh");
  for (const candidate of [opts.override, opts.configured]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  for (const name of KEY_CANDIDATES) {
    const path = join(sshDir, name);
    if (existsSync(path)) return path;
  }
  return undefined;
}

/**
 * cwRsync's cygwin ssh rejects CRLF keys. Rather than rewriting the user's
 * key in place, write a normalised copy into our own cache directory.
 * Returns the original path when no change is needed.
 */
export function normalizedKeyCopy(keyPath: string, cacheDir: string): string {
  const raw = readFileSync(keyPath, "utf-8");
  const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const withNewline = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  if (withNewline === raw) return keyPath;

  mkdirSync(cacheDir, { recursive: true });
  const hash = createHash("sha256").update(keyPath).digest("hex").slice(0, 16);
  const dest = join(cacheDir, hash);
  writeFileSync(dest, withNewline, { mode: 0o600 });
  try { chmodSync(dest, 0o600); } catch { /* best effort on Windows */ }
  return dest;
}

/** Force a login shell so Homebrew-installed tools are on PATH over SSH. */
export function loginWrap(cmd: string): string {
  return `$SHELL -lc '${cmd.replace(/'/g, "'\\''")}'`;
}

/** Windows: D:\foo → /cygdrive/d/foo, which is what cwRsync expects. */
export function toRsyncPath(localPath: string, platform: string = process.platform): string {
  if (platform !== "win32") return localPath;
  return localPath
    .replace(/\\/g, "/")
    .replace(/^([A-Z]):/i, (_, drive: string) => `/cygdrive/${drive.toLowerCase()}`);
}

export interface SshTarget {
  host: string;
  user?: string;
}

export function sshTargetString(target: SshTarget): string {
  return target.user ? `${target.user}@${target.host}` : target.host;
}

/** Run a command on the Mac and return stdout. Throws BuildError on failure. */
export function ssh(target: SshTarget, cmd: string, opts?: { allowFailure?: boolean }): string {
  try {
    return execFileSync(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=15", sshTargetString(target), loginWrap(cmd)],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch (err) {
    if (opts?.allowFailure) return "";
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? "";
    throw new BuildError(
      `SSH command failed on ${sshTargetString(target)}: ${cmd}`,
      stderr || `Check that you can run: ssh ${sshTargetString(target)}`,
    );
  }
}

/** Locate cwRsync's bundled cygwin ssh.exe. Win32-OpenSSH breaks rsync's protocol. */
export function findCwrsyncSsh(): string {
  try {
    const rsyncPath = execFileSync("where.exe", ["rsync.exe"], {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"],
    }).trim().split("\n")[0]!.trim();
    const chocoLib = join(rsyncPath, "..", "..", "lib", "rsync", "tools", "bin", "ssh.exe");
    if (existsSync(chocoLib)) return chocoLib;
    const sibling = join(rsyncPath, "..", "ssh.exe");
    if (existsSync(sibling)) return sibling;
  } catch { /* fall through to the error below */ }
  throw new BuildError(
    "Could not find cwRsync's bundled ssh.exe",
    "Install rsync with: choco install rsync",
  );
}
