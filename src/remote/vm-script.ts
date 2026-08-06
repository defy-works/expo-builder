import type { Profile } from "../args";

export interface OptimizeFlags {
  /** Gradle memory/lint tuning. */
  android: boolean;
  /** Disable the Xcode index store (IDE-only feature). */
  indexStore: boolean;
  /** Skip dSYM generation for non-production builds. */
  skipDsym: boolean;
  /** ccache for C/C++/ObjC compilation. */
  ccache: boolean;
}

export const DEFAULT_OPTIMIZE: OptimizeFlags = {
  android: true, indexStore: true, skipDsym: true, ccache: true,
};
export const NO_OPTIMIZE: OptimizeFlags = {
  android: false, indexStore: false, skipDsym: false, ccache: false,
};

export interface VmScriptOptions {
  expoToken: string;
  profile: Profile;
  platform: "android" | "ios";
  submit: boolean;
  optimize: OptimizeFlags;
  cacheEnabled: boolean;
  /** Tart --dir mount name for the synced source. */
  mountName: string;
  /** Mobile dir relative to the sync root; "" when they are the same. */
  mobileRelPath: string;
  javaVersion: string;
}

export const CACHE_MOUNT_NAME = "expo-builder-cache";

/** Where Tart exposes --dir mounts inside the guest. */
function mountPath(name: string): string {
  return `/Volumes/My Shared Files/${name}`;
}

export function generateVmScript(opts: VmScriptOptions): string {
  const {
    expoToken, profile, platform, submit, optimize, cacheEnabled,
    mountName, mobileRelPath, javaVersion,
  } = opts;

  const ext = platform === "ios" ? "ipa" : "aab";
  const artifact = `$HOME/out/app.${ext}`;
  const versionField = platform === "ios" ? "buildNumber" : "versionCode";
  const workRoot = "$HOME/work";
  const workDir = mobileRelPath ? `${workRoot}/${mobileRelPath}` : workRoot;
  const anyIosOpt = optimize.indexStore || optimize.skipDsym || optimize.ccache;

  const lines: string[] = [
    "set -euo pipefail",
    `export PATH="$HOME/.bun/bin:/opt/homebrew/opt/openjdk@${javaVersion}/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"`,
    `export JAVA_HOME="/opt/homebrew/opt/openjdk@${javaVersion}"`,
    'export ANDROID_HOME="$HOME/Library/Android/sdk"',
    `export EXPO_TOKEN="${expoToken}"`,
    "",
    "# EAS packages the project itself and honours .gitignore/.easignore, so no",
    "# git repository is needed. The project would otherwise be a mount owned by",
    "# the host user, which git rejects as dubious — killing `eas build --local`",
    "# on `git rev-parse --show-toplevel` with exit 128 and no explanation.",
    "export EAS_NO_VCS=1",
    "git config --global --add safe.directory '*' 2>/dev/null || true",
    "",
    "# Consumed by the withBuildOptimizations config plugin",
    `export OPTIMIZE_INDEX_STORE="${optimize.indexStore}"`,
    `export OPTIMIZE_SKIP_DSYM="${optimize.skipDsym}"`,
    `export OPTIMIZE_CCACHE="${optimize.ccache}"`,
    "",
  ];

  // Stage source onto the VM's own disk. The mount is read-only and slow;
  // building in place would also leave node_modules and artifacts on the Mac.
  lines.push(
    'echo "::phase::stage"',
    'mkdir -p "$HOME/work" "$HOME/out"',
    `rsync -a --delete "${mountPath(mountName)}/" "$HOME/work/"`,
    `cd "${workDir}"`,
    "",
    "# Leftover wrapper from a previously interrupted build",
    "[ -f _app.config.original.ts ] && mv _app.config.original.ts app.config.ts || true",
    "",
  );

  if (cacheEnabled) {
    const cache = mountPath(CACHE_MOUNT_NAME);
    lines.push(
      'echo "::phase::cache-setup"',
      `CACHE_DIR="${cache}"`,
      'mkdir -p "$CACHE_DIR/bun" "$CACHE_DIR/gradle-caches" "$CACHE_DIR/gradle-wrapper" "$CACHE_DIR/cocoapods" "$CACHE_DIR/ccache"',
      "",
      "# Symlink rather than env vars: zero setup time, writes persist immediately.",
      "mkdir -p ~/.bun/install ~/.gradle ~/Library/Caches",
      'rm -rf ~/.bun/install/cache && ln -sfn "$CACHE_DIR/bun" ~/.bun/install/cache',
      'rm -rf ~/.gradle/caches ~/.gradle/wrapper',
      'ln -sfn "$CACHE_DIR/gradle-caches" ~/.gradle/caches',
      'ln -sfn "$CACHE_DIR/gradle-wrapper" ~/.gradle/wrapper',
      'rm -rf ~/Library/Caches/CocoaPods && ln -sfn "$CACHE_DIR/cocoapods" ~/Library/Caches/CocoaPods',
      "",
    );

    if (optimize.ccache) {
      lines.push(
        "# ccache caches compiled objects by content hash, so it survives EAS",
        "# copying the project to a fresh temp dir each build — which is exactly",
        "# why DerivedData cannot be cached.",
        "if command -v ccache >/dev/null 2>&1; then",
        '  rm -rf ~/.ccache && ln -sfn "$CACHE_DIR/ccache" ~/.ccache',
        "  cat > ~/.ccache/ccache.conf << 'CCEOF'",
        "max_size = 2G",
        "sloppiness = clang_index_store,file_stat_matches,include_file_ctime,include_file_mtime,modules,system_headers,time_macros",
        "CCEOF",
        '  XCODE_CLANG="$(xcrun -f clang)"',
        '  XCODE_CLANGPP="$(xcrun -f clang++)"',
        "  mkdir -p /tmp/ccache-bin",
        `  printf '#!/bin/bash\\nexec /opt/homebrew/bin/ccache "%s" "$@"\\n' "$XCODE_CLANG" > /tmp/ccache-bin/clang`,
        `  printf '#!/bin/bash\\nexec /opt/homebrew/bin/ccache "%s" "$@"\\n' "$XCODE_CLANGPP" > /tmp/ccache-bin/clang++`,
        "  chmod +x /tmp/ccache-bin/clang /tmp/ccache-bin/clang++",
        "fi",
        "",
      );
    }
  }

  // Gradle config must land before anything evaluates the project.
  if (optimize.android && platform === "android") {
    lines.push(
      "# Gradle tuning — dynamic memory, disable lint, limit workers",
      "mkdir -p ~/.gradle",
      "TOTAL_MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))",
      "JVM_MAX_GB=$(( TOTAL_MEM_GB > 4 ? TOTAL_MEM_GB - 2 : 2 ))",
      "cat > ~/.gradle/gradle.properties << GEOF",
      "org.gradle.caching=true",
      "org.gradle.workers.max=2",
      "reactNativeArchitectures=arm64-v8a",
      "org.gradle.jvmargs=-Xmx${JVM_MAX_GB}g -XX:MaxMetaspaceSize=512m -XX:+HeapDumpOnOutOfMemoryError",
      "GEOF",
      "cat > ~/.gradle/init.gradle << 'GEOF'",
      "allprojects {",
      "    afterEvaluate {",
      "        tasks.matching { it.name.contains('lintVital') }.configureEach {",
      "            enabled = false",
      "        }",
      "    }",
      "}",
      "GEOF",
      "",
    );
  }

  // install BEFORE env:pull — `eas env:pull` evaluates app.config.ts, which may
  // reference plugins (e.g. @sentry/react-native/expo) that need node_modules.
  // --backend=copyfile: bun defaults to clonefile on macOS, which fails across
  // VirtioFS boundaries.
  lines.push(
    'echo "::phase::install"',
    `bun install --frozen-lockfile${cacheEnabled ? " --backend=copyfile" : ""}`,
    "",
    'echo "::phase::env-pull"',
    `eas env:pull --environment ${profile} --non-interactive`,
    "",
  );

  if (anyIosOpt) {
    // Injected in place rather than via a wrapper module: @expo/config's require
    // resolution cannot resolve .ts imports from a wrapper, so the wrapper
    // approach silently broke config evaluation.
    lines.push(
      "# Inject the iOS build optimization plugin into the plugins array",
      'if [ -f app.config.ts ] && ! grep -q "withBuildOptimizations" app.config.ts; then',
      "  cat > /tmp/inject-plugin.mjs << 'INJECT'",
      'import { readFileSync, writeFileSync } from "fs";',
      'const f = "app.config.ts";',
      'let c = readFileSync(f, "utf8");',
      "c = c.replace(/plugins:\\s*\\[/, 'plugins: [\\n    \"./plugins/withBuildOptimizations\",');",
      "writeFileSync(f, c);",
      "INJECT",
      "  bun /tmp/inject-plugin.mjs",
      "fi",
      "",
    );
  }

  lines.push(
    'echo "::phase::build"',
    "[ ! -f .env.local ] && touch .env.local",
    `dotenv -e .env.local -- eas build --local --platform ${platform} --profile ${profile} --output ${artifact} --non-interactive 2>&1`,
    "",
    'echo "::phase::version"',
    `VERSION_JSON=$(eas build:version:get -p ${platform} --profile ${profile} --json --non-interactive 2>/dev/null || echo '{}')`,
    `CUR=$(echo "$VERSION_JSON" | bun -e "const d=JSON.parse(await Bun.stdin.text()); process.stdout.write(String(d.${versionField}??0))")`,
    "NEXT=$((CUR + 1))",
    'echo "::version::$CUR → $NEXT"',
    "# `eas build:version:set` is interactive-only on EAS CLI v18+ (no --version,",
    "# no --non-interactive), so it cannot be scripted. set-version.ts calls the",
    "# same createAppVersion GraphQL mutation the CLI uses underneath.",
    `bun ${workRoot}/set-version.ts ${platform} "$NEXT" || echo "::error::Version increment failed"`,
  );

  if (submit) {
    lines.push(
      "",
      'echo "::phase::submit"',
      `eas submit --platform ${platform} --profile ${profile} --path ${artifact} --non-interactive`,
    );
  }

  return lines.join("\n");
}
