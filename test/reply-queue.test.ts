import { describe, expect, test } from "bun:test";
import { ReplyQueue } from "../src/reply-queue.js";

describe("ReplyQueue", () => {
  test("drops new items when full", () => {
    const queue = new ReplyQueue(2, 1000);
    expect(queue.enqueue("one", 0)).toBe(true);
    expect(queue.enqueue("two", 0)).toBe(true);
    expect(queue.enqueue("three", 0)).toBe(false);
    expect(queue.length).toBe(2);
  });

  test("skips stale items and returns fresh item", () => {
    const queue = new ReplyQueue(5, 1000);
    queue.enqueue("old", 0);
    queue.enqueue("fresh", 1500);
    expect(queue.nextFresh(2001)?.text).toBe("fresh");
    expect(queue.length).toBe(0);
  });
});
