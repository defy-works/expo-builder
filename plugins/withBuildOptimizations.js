/**
 * Expo config plugin for CI/VM build optimizations (iOS only).
 *
 * Auto-injected by expo-builder during remote builds (via in-place injection
 * into app.config.ts plugins array). The project's app.config.ts does NOT
 * need to reference this file.
 *
 * Android optimizations are handled entirely in the build script (scripts/eas.ts)
 * via ~/.gradle/ config files, since they don't require modifying the Xcode project.
 *
 * What it does:
 *   1. Disable Xcode index store (IDE feature, not needed for CI)
 *   2. Skip dSYM generation for non-production builds (faster, less memory)
 *   3. Enable ccache for C/C++/ObjC compilation (if ccache wrapper scripts exist)
 *      — set CC/CXX on the main app target + all pod targets via Podfile post_install
 */
const { withXcodeProject, withDangerousMod } = require("expo/config-plugins");
const fs = require("fs");
const path = require("path");

// ccache wrapper scripts created by the build script (scripts/eas.ts)
// These embed the full path to Xcode's clang, so ccache wraps the right compiler.
const CCACHE_CLANG = "/tmp/ccache-bin/clang";
const CCACHE_CLANGPP = "/tmp/ccache-bin/clang++";

function withBuildOptimizations(config) {
  // Read granular optimization flags from env vars (set by expo-builder).
  // Default to "true" when absent for backward compatibility.
  const enableIndexStore = process.env.OPTIMIZE_INDEX_STORE !== "false";
  const enableSkipDsym = process.env.OPTIMIZE_SKIP_DSYM !== "false";
  const enableCcache = process.env.OPTIMIZE_CCACHE !== "false";

  // 1. Modify main Xcode project: index store, dSYM, ccache for app target
  config = withXcodeProject(config, (config) => {
    const project = config.modResults;
    const buildProfile = process.env.EAS_BUILD_PROFILE || "";
    const isProduction = buildProfile === "production";
    const hasCcache = enableCcache && fs.existsSync(CCACHE_CLANG);

    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key in configurations) {
      const buildSettings = configurations[key].buildSettings;
      if (!buildSettings) continue;

      // ccache for ALL targets in the main project (app + extensions)
      if (hasCcache) {
        buildSettings.CC = `"${CCACHE_CLANG}"`;
        buildSettings.CXX = `"${CCACHE_CLANGPP}"`;
      }

      // Remaining optimizations: main app target only
      if (!buildSettings.INFOPLIST_FILE?.includes?.("app/")) continue;

      // Disable index store — saves memory and time (IDE-only feature)
      if (enableIndexStore) {
        buildSettings.COMPILER_INDEX_STORE_ENABLE = "NO";
      }

      // Skip dSYM generation for non-production builds
      // (dSYMs are needed for crash symbolication in production)
      if (enableSkipDsym && !isProduction && buildSettings.name === "Release") {
        buildSettings.DEBUG_INFORMATION_FORMAT = "dwarf";
      }
    }

    return config;
  });

  // 2. Modify Podfile: ccache for pod targets (runs before pod install)
  config = withDangerousMod(config, [
    "ios",
    (config) => {
      if (!enableCcache || !fs.existsSync(CCACHE_CLANG)) return config;

      const podfile = path.join(config.modRequest.platformProjectRoot, "Podfile");
      if (!fs.existsSync(podfile)) return config;

      let contents = fs.readFileSync(podfile, "utf-8");

      // Inject ccache build settings into the existing post_install block
      if (contents.includes("post_install do |installer|")) {
        const ccacheSnippet = [
          "",
          "    # ccache for all pod targets (auto-injected by withBuildOptimizations)",
          "    installer.pods_project.targets.each do |target|",
          "      target.build_configurations.each do |bc|",
          `        bc.build_settings['CC'] = '${CCACHE_CLANG}'`,
          `        bc.build_settings['CXX'] = '${CCACHE_CLANGPP}'`,
          "      end",
          "    end",
        ].join("\n");

        contents = contents.replace(
          /post_install do \|installer\|/,
          `post_install do |installer|${ccacheSnippet}`
        );

        fs.writeFileSync(podfile, contents);
      }

      return config;
    },
  ]);

  return config;
}

module.exports = withBuildOptimizations;
