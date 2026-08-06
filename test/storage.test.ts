import { expect, test } from "bun:test";
import {
  parseDiskutilInfo, validateVolume, deriveKeepImages, planImageEviction,
  diskutilCommandFor, GB,
} from "../src/remote/storage";

const apfsSsd = `
   Device Identifier:        disk5s1
   Volume Name:              BuildSSD
   Mounted:                  Yes
   File System Personality:  APFS
   Type (Bundle):            apfs
   Owners:                   Enabled
   Protocol:                 USB
   SMART Status:             Verified
   Solid State:              Yes
   Volume Free Space:        900.0 GB (900000000000 Bytes)
`;

test("parses an APFS SSD volume", () => {
  const v = parseDiskutilInfo(apfsSsd);
  expect(v.isAPFS).toBe(true);
  expect(v.ownershipEnabled).toBe(true);
  expect(v.solidState).toBe(true);
  expect(v.freeBytes).toBe(900000000000);
});

test("parses the real APFS internal-volume layout, which uses Container Free Space", () => {
  // Verbatim shape from `diskutil info /` on macOS 26.6.
  const real = `
   Volume Name:               Macintosh HD
   File System Personality:   APFS
   Owners:                    Enabled
   Protocol:                  Apple Fabric
   Container Free Space:      112.6 GB (112645550080 Bytes) (exactly 220010840 512-Byte-Units)
   Solid State:               Yes
`;
  const v = parseDiskutilInfo(real);
  expect(v.isAPFS).toBe(true);
  expect(v.freeBytes).toBe(112645550080);
  expect(v.solidState).toBe(true);
  expect(validateVolume(v).errors).toEqual([]);
});

test("diskutil is pointed at the mount point, not the raw path", () => {
  // `diskutil info /Users/mingu` fails with "Could not find disk".
  const cmd = diskutilCommandFor("$HOME");
  expect(cmd).toContain("df -P");
  expect(cmd).toContain("diskutil info");
});

test("an APFS SSD with ownership enabled passes cleanly", () => {
  const r = validateVolume(parseDiskutilInfo(apfsSsd));
  expect(r.errors).toEqual([]);
  expect(r.warnings).toEqual([]);
});

test("a non-APFS volume is a hard error mentioning clonefile cost", () => {
  const v = parseDiskutilInfo(apfsSsd.replace("APFS", "ExFAT").replace("apfs", "exfat"));
  const r = validateVolume(v);
  expect(r.errors.length).toBe(1);
  expect(r.errors[0]).toContain("APFS");
  expect(r.errors[0]).toContain("copy");
});

test("ownership disabled is an error with the enableOwnership remedy", () => {
  const v = parseDiskutilInfo(apfsSsd.replace("Owners:                   Enabled", "Owners:                   Disabled"));
  const r = validateVolume(v);
  expect(r.errors.join(" ")).toContain("enableOwnership");
});

test("rotational media warns but does not block", () => {
  const v = parseDiskutilInfo(apfsSsd.replace("Solid State:              Yes", "Solid State:              No"));
  const r = validateVolume(v);
  expect(r.errors).toEqual([]);
  expect(r.warnings.join(" ")).toContain("slower");
});

test("network volumes are rejected", () => {
  const v = parseDiskutilInfo(apfsSsd.replace("Protocol:                 USB", "Protocol:                 SMB"));
  const r = validateVolume(v);
  expect(r.errors.join(" ")).toContain("Network");
});

test("keepImages is 1 below the 150GB threshold", () => {
  expect(deriveKeepImages(100 * GB, "auto")).toBe(1);
  expect(deriveKeepImages(149 * GB, "auto")).toBe(1);
});

test("keepImages grows with free space, capped at 3", () => {
  expect(deriveKeepImages(200 * GB, "auto")).toBe(2);
  expect(deriveKeepImages(400 * GB, "auto")).toBe(3);
  expect(deriveKeepImages(2000 * GB, "auto")).toBe(3);
});

test("an explicit keepImages overrides derivation", () => {
  expect(deriveKeepImages(100 * GB, 3)).toBe(3);
});

test("eviction keeps the most recently accessed images up to the limit", () => {
  const evict = planImageEviction(
    [
      { name: "expo-builder-xcode-26.6", accessed: 300 },
      { name: "expo-builder-xcode-26.4", accessed: 200 },
      { name: "expo-builder-xcode-26.2", accessed: 100 },
    ],
    2,
  );
  expect(evict).toEqual(["expo-builder-xcode-26.2"]);
});

test("eviction is empty when under the limit", () => {
  expect(planImageEviction([{ name: "a", accessed: 1 }], 3)).toEqual([]);
});
