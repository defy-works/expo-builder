import { expect, test } from "bun:test";
import { generateHostScript, type HostScriptOptions } from "../src/remote/host-script";

const base: HostScriptOptions = {
  imageName: "expo-builder",
  mountName: "my-app",
  remotePath: "/Users/mingu/.expo-builder/projects/my-app",
  cachePath: "/Users/mingu/.expo-builder/cache",
  artifactDir: "/Users/mingu/.expo-builder/artifacts/my-app/20260806",
  artifactExt: "ipa",
  stateFile: "/tmp/expo-builder-vm-123",
  vmScript: "echo hello",
  timestamp: 1770000000,
};

function lineIndex(script: string, needle: string): number {
  const lines = script.split("\n");
  const i = lines.findIndex((l) => l.includes(needle));
  if (i === -1) throw new Error(`not found in script: ${needle}`);
  return i;
}

test("the cleanup trap is registered before the VM is cloned", () => {
  const script = generateHostScript(base);
  expect(lineIndex(script, "trap cleanup")).toBeLessThan(lineIndex(script, "tart clone"));
});

test("the trap covers HUP so an SSH disconnect still tears down", () => {
  const script = generateHostScript(base);
  const trapLine = script.split("\n").find((l) => l.startsWith("trap cleanup"))!;
  for (const sig of ["EXIT", "INT", "TERM", "HUP"]) {
    expect(trapLine).toContain(sig);
  }
});

test("cleanup is guarded so it is a no-op when no VM was created", () => {
  const script = generateHostScript(base);
  expect(script).toContain("VM_CREATED=0");
  expect(script).toContain('[ "$VM_CREATED" = 1 ]');
  expect(lineIndex(script, "VM_CREATED=1")).toBeGreaterThan(lineIndex(script, "tart clone"));
});

test("teardown stops with a timeout, waits for the VM to leave running, then deletes", () => {
  const script = generateHostScript(base);
  expect(script).toContain("tart stop -t 30");
  expect(script).toContain("Running");
  expect(lineIndex(script, "tart stop -t 30")).toBeLessThan(lineIndex(script, "tart delete"));
});

test("delete is retried and a persistent failure is reported, not swallowed", () => {
  const script = generateHostScript(base);
  const destroy = script.slice(script.indexOf("destroy_vm()"), script.indexOf("cleanup()"));
  expect(destroy).toContain("for");
  expect(destroy).toContain("::error::");
  expect(destroy).not.toMatch(/tart delete "\$VM" 2>\/dev\/null \|\| true\s*$/m);
});

test("the stale sweep skips running VMs", () => {
  const script = generateHostScript(base);
  const sweep = script.slice(script.indexOf("# Stale VM sweep"), script.indexOf('echo "::phase::clone-vm"'));
  expect(sweep).toContain("Running");
  expect(sweep).toContain("continue");
});

test("the stale sweep matches both new and legacy VM name prefixes", () => {
  const script = generateHostScript(base);
  expect(script).toContain("expo-builder-build-");
  expect(script).toContain("^build-");
});

test("the stale sweep does not delete a VM whose owning process is alive", () => {
  const script = generateHostScript(base);
  expect(script).toContain("kill -0");
});

test("the VM name embeds the shell PID so liveness can be checked", () => {
  expect(generateHostScript(base)).toContain('VM="expo-builder-build-$$-1770000000"');
});

test("the source mount is read-only", () => {
  expect(generateHostScript(base)).toContain(
    "--dir=my-app:/Users/mingu/.expo-builder/projects/my-app:ro"
  );
});

test("the cache mount is read-write when a cache path is given", () => {
  const script = generateHostScript(base);
  expect(script).toContain("--dir=expo-builder-cache:/Users/mingu/.expo-builder/cache");
  expect(script).not.toContain("--dir=expo-builder-cache:/Users/mingu/.expo-builder/cache:ro");
});

test("the cache mount is omitted when no cache path is given", () => {
  const script = generateHostScript({ ...base, cachePath: undefined });
  expect(script).not.toContain("expo-builder-cache");
});

test("TART_HOME is exported when configured", () => {
  const script = generateHostScript({ ...base, tartHome: "/Volumes/BuildSSD/.tart" });
  expect(script).toContain('export TART_HOME="/Volumes/BuildSSD/.tart"');
});

test("the artifact is copied out of the VM before teardown", () => {
  const script = generateHostScript(base);
  expect(script).toContain("app.ipa");
  expect(script).toContain(base.artifactDir);
  expect(lineIndex(script, base.artifactDir)).toBeLessThan(lineIndex(script, "trap - EXIT"));
});

test("uses set -euo pipefail", () => {
  expect(generateHostScript(base)).toContain("set -euo pipefail");
});

test("VM-directed SSH discards known_hosts", () => {
  // Ephemeral VMs recycle IPs. StrictHostKeyChecking=no does NOT bypass a
  // *changed* host key, so without this every build eventually fails once the
  // Mac has accumulated a key for that IP from an earlier VM.
  const script = generateHostScript(base);
  expect(script).toContain("UserKnownHostsFile=/dev/null");
  const sshLine = script.split("\n").find((l) => l.startsWith("VM_SSH="))!;
  expect(sshLine).toContain("$VM_SSH_OPTS");
  const scpLine = script.split("\n").find((l) => l.startsWith("scp "))!;
  expect(scpLine).toContain("$VM_SSH_OPTS");
});

test("a VMEOF sentinel inside the VM script cannot break the heredoc", () => {
  const script = generateHostScript({ ...base, vmScript: "echo a\nVMEOF\necho b" });
  const heredocs = script.split("\n").filter((l) => l === "VMEOF");
  expect(heredocs.length).toBe(1);
});

test("host script matches the approved snapshot", () => {
  expect(generateHostScript(base)).toMatchSnapshot();
});

test("host script without cache matches the approved snapshot", () => {
  expect(generateHostScript({ ...base, cachePath: undefined })).toMatchSnapshot();
});
