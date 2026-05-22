import { describe, expect, test } from "bun:test";
import { renderTranscript, sortSegments, type Segment } from "../src/transcript-writer.js";

const late = new Date("2026-05-17T10:00:10.000Z");
const early = new Date("2026-05-17T10:00:01.000Z");

function segment(startedAt: Date, text: string): Segment {
  return {
    speaker: "BM",
    speakerId: "1",
    startedAt,
    endedAt: new Date(startedAt.getTime() + 1000),
    text,
    language: "th",
  };
}

describe("transcript rendering", () => {
  test("sorts segments chronologically", () => {
    const sorted = sortSegments([segment(late, "late"), segment(early, "early")]);
    expect(sorted.map(s => s.text)).toEqual(["early", "late"]);
  });

  test("renders sorted transcript content", () => {
    const content = renderTranscript(
      [segment(late, "late"), segment(early, "early")],
      "voice",
      early,
      new Set(["BM"]),
    );
    expect(content.indexOf("early")).toBeLessThan(content.indexOf("late"));
    expect(content).toContain("**Participants**: BM");
    expect(content).toContain("**Segments**: 2");
  });
});
