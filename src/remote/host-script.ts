import { CACHE_MOUNT_NAME } from "./vm-script";

export interface HostScriptOptions {
  /** Local Tart image to clone from. */
  imageName: string;
  /** Tart --dir mount name for the synced source. */
  mountName: string;
  /** Synced source directory on the Mac. */
  remotePath: string;
  /** Shared cache directory on the Mac, or undefined to disable caching. */
  cachePath?: string;
  /** Where the built artifact is copied on the Mac. */
  artifactDir: string;
  artifactExt: string;
  stateFile: string;
  /** Bash to execute inside the VM. */
  vmScript: string;
  timestamp: number;
  tartHome?: string;
}

export function generateHostScript(opts: HostScriptOptions): string {
  const {
    imageName, mountName, remotePath, cachePath, artifactDir, artifactExt,
    stateFile, vmScript, timestamp, tartHome,
  } = opts;

  // Neutralise any line that would terminate the heredoc early.
  const safeVmScript = vmScript.replace(/^VMEOF$/gm, "VM_EOF_ESCAPED");

  const mounts = [`--dir=${mountName}:${remotePath}:ro`];
  if (cachePath) mounts.push(`--dir=${CACHE_MOUNT_NAME}:${cachePath}`);

  return `set -euo pipefail

# Non-interactive SSH does not source the login shell, so Homebrew tools
# (tart, rsync) are not on PATH. Import it explicitly.
eval "$($SHELL -lc 'echo export PATH="$PATH"')"
${tartHome ? `export TART_HOME="${tartHome}"\n` : ""}
VM="expo-builder-build-$$-${timestamp}"
VM_CREATED=0
echo "$VM" > ${stateFile}

# Wait for a VM to leave the running state, then delete it with retries.
# A silent failure here is what leaks VMs, so a persistent failure is reported.
destroy_vm() {
  local name="$1"
  tart stop -t 30 "$name" 2>/dev/null || true

  local waited=0
  while [ $waited -lt 60 ]; do
    if ! tart list --format json 2>/dev/null \\
      | grep -A5 "\\"Name\\" : \\"$name\\"" | grep -q '"Running" : true'; then
      break
    fi
    sleep 2
    waited=$((waited + 2))
  done

  local attempt
  for attempt in 1 2 3 4 5; do
    if tart delete "$name" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done

  if tart list --quiet 2>/dev/null | grep -qx "$name"; then
    echo "::error::Failed to delete VM $name after 5 attempts. Run: tart delete $name"
  fi
}

cleanup() {
  local rc=$?
  if [ "$VM_CREATED" = 1 ]; then
    echo "::phase::cleanup"
    destroy_vm "$VM"
  fi
  rm -f ${stateFile}
  exit $rc
}

# Registered BEFORE any VM exists, and covering HUP: bash does not run EXIT
# traps on an untrapped SIGHUP, so without HUP an SSH disconnect leaks the VM.
trap cleanup EXIT INT TERM HUP

# Stale VM sweep. Only removes VMs that are not running and whose owning
# shell is gone, so a concurrent build is never destroyed.
for STALE in $(tart list --quiet 2>/dev/null | grep -E '^expo-builder-build-|^build-' || true); do
  if tart list --format json 2>/dev/null \\
    | grep -A5 "\\"Name\\" : \\"$STALE\\"" | grep -q '"Running" : true'; then
    continue
  fi
  STALE_PID=$(echo "$STALE" | sed -n 's/^expo-builder-build-\\([0-9]*\\)-.*$/\\1/p')
  if [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; then
    continue
  fi
  echo "::stale::$STALE"
  destroy_vm "$STALE"
done

echo "::phase::clone-vm"
tart clone ${imageName} "$VM"
VM_CREATED=1

TOTAL_CPU=$(sysctl -n hw.ncpu)
TOTAL_MEM_MB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 ))
VM_CPU=$((TOTAL_CPU > 4 ? TOTAL_CPU - 2 : TOTAL_CPU))
VM_MEM_MB=$((TOTAL_MEM_MB > 8192 ? TOTAL_MEM_MB - 4096 : TOTAL_MEM_MB))
tart set "$VM" --cpu $VM_CPU --memory $VM_MEM_MB
echo "::vm-resources::$VM_CPU CPUs, $((VM_MEM_MB / 1024))GB RAM"

echo "::phase::boot-vm"
mkdir -p ${cachePath ? `"${cachePath}" ` : ""}"${artifactDir}"
tart run ${mounts.join(" ")} --no-graphics "$VM" &

VM_IP=""
for i in $(seq 1 30); do
  VM_IP=$(tart ip "$VM" 2>/dev/null) && [ -n "$VM_IP" ] && break
  echo "::boot-wait::$((i * 3))"
  sleep 3
done

if [ -z "$VM_IP" ]; then
  echo "::error::VM failed to boot within 90 seconds"
  exit 1
fi
echo "::vm-ip::$VM_IP"

VM_SSH="ssh -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i $HOME/.ssh/id_ed25519 -o ConnectTimeout=30 admin@$VM_IP"

$VM_SSH bash -s <<'VMEOF'
${safeVmScript}
VMEOF

echo "::phase::artifact"
scp -o StrictHostKeyChecking=no -o IdentitiesOnly=yes -i "$HOME/.ssh/id_ed25519" \\
  "admin@$VM_IP:out/app.${artifactExt}" "${artifactDir}/app.${artifactExt}"

trap - EXIT
cleanup
`;
}
