import { expect, test } from "bun:test";
import { parseMarker } from "../src/remote/markers";

test("parses a phase marker", () => {
  expect(parseMarker("::phase::build")).toEqual({ kind: "phase", value: "build" });
});

test("parses vm-ip, boot-wait, version, stale and error markers", () => {
  expect(parseMarker("::vm-ip::192.168.64.7")).toEqual({ kind: "vm-ip", value: "192.168.64.7" });
  expect(parseMarker("::boot-wait::12")).toEqual({ kind: "boot-wait", value: "12" });
  expect(parseMarker("::version::4 → 5")).toEqual({ kind: "version", value: "4 → 5" });
  expect(parseMarker("::stale::expo-builder-build-1")).toEqual({ kind: "stale", value: "expo-builder-build-1" });
  expect(parseMarker("::error::it broke")).toEqual({ kind: "error", value: "it broke" });
});

test("returns null for ordinary output", () => {
  expect(parseMarker("Compiling AppDelegate.swift")).toBeNull();
  expect(parseMarker("::not-a-marker")).toBeNull();
});

test("unknown marker kinds are ignored rather than misparsed", () => {
  expect(parseMarker("::teleport::somewhere")).toBeNull();
});
