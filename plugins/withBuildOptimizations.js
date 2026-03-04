/**
 * Expo config plugin for CI/VM build optimizations (iOS only).
 *
 * Auto-injected by expo-builder during remote builds (via app.config wrapper).
 * The project's app.config.ts does NOT need to reference this file — it's
 * copied to plugins/ and added to the plugins array automatically.
 *
 * Android optimizations are handled entirely in the build script (scripts/eas.ts)
 * via ~/.gradle/ config files, since they don't require modifying the Xcode project.
 *
 * What it does:
 *   1. Disable Xcode index store (IDE feature, not needed for CI)
 *   2. Skip dSYM generation for non-production builds (faster, less memory)
 */
const { withXcodeProject } = require("expo/config-plugins");

function withBuildOptimizations(config) {
  return withXcodeProject(config, (config) => {
    const project = config.modResults;
    const buildProfile = process.env.EAS_BUILD_PROFILE || "";
    const isProduction = buildProfile === "production";

    const configurations = project.pbxXCBuildConfigurationSection();
    for (const key in configurations) {
      const buildSettings = configurations[key].buildSettings;
      if (!buildSettings) continue;

      // Only apply to the main app target
      if (!buildSettings.INFOPLIST_FILE?.includes?.("app/")) continue;

      // Disable index store — saves memory and time (IDE-only feature)
      buildSettings.COMPILER_INDEX_STORE_ENABLE = "NO";

      // Skip dSYM generation for non-production builds
      // (dSYMs are needed for crash symbolication in production)
      if (!isProduction && buildSettings.name === "Release") {
        buildSettings.DEBUG_INFORMATION_FORMAT = "dwarf";
      }
    }

    return config;
  });
}

module.exports = withBuildOptimizations;
