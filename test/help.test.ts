import { expect, test } from "bun:test";
import { helpText, COMMAND_HELP, COMMANDS } from "../src/args";

test("global help lists every command except interactive", () => {
  const text = helpText();
  for (const cmd of COMMANDS) {
    if (cmd === "interactive") continue;
    expect(text).toContain(cmd);
  }
});

test("global help documents the flags that change build destination", () => {
  const text = helpText();
  expect(text).toContain("--remote");
  expect(text).toContain("--cloud");
  expect(text).toContain("--no-optimize");
});

test("every command has its own help entry", () => {
  for (const cmd of COMMANDS) {
    if (cmd === "interactive") continue;
    expect(COMMAND_HELP[cmd]).toBeDefined();
    expect(helpText(cmd).length).toBeGreaterThan(20);
  }
});

test("command help includes usage and an example", () => {
  const text = helpText("build");
  expect(text).toContain("Usage:");
  expect(text).toContain("expo-builder build");
});
