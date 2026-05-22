import { describe, expect, test } from "bun:test";
import { isNameMentioned, isTriggered } from "../src/trigger.js";

describe("trigger detection", () => {
  test("requires a Codey name variant", () => {
    expect(isTriggered("ช่วยสรุปให้หน่อย")).toBe(false);
    expect(isNameMentioned("ช่วยสรุปให้หน่อย")).toBe(false);
  });

  test("triggers on name plus request", () => {
    expect(isTriggered("โคดี้ช่วยสรุปให้หน่อย")).toBe(true);
    expect(isTriggered("Codey what do you think?")).toBe(true);
  });

  test("does not treat generic code talk as Codey", () => {
    expect(isTriggered("วันนี้เขียนโค้ดนะ")).toBe(false);
  });
});
