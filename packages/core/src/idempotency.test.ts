import { describeIdempotencyStore } from "@syrinx/testing/stores";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryIdempotencyStore } from "./idempotency.js";

describeIdempotencyStore("memory", (timings) => createMemoryIdempotencyStore(timings));

describe("memory store", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops expired keys nobody asks about again", async () => {
    vi.useFakeTimers();
    const store = createMemoryIdempotencyStore({ inFlightTtlMs: 1000, maxEntries: 3 });
    await store.begin("a", "fp");
    await store.begin("b", "fp");
    vi.advanceTimersByTime(1500);
    // The sweep on this claim drops a and b, so the cap of 3 never evicts c or d.
    await store.begin("c", "fp");
    await store.begin("d", "fp");
    await store.begin("e", "fp");
    await expect(store.begin("c", "fp")).resolves.toEqual({ status: "in_flight" });
  });

  it("evicts the oldest keys past maxEntries", async () => {
    const store = createMemoryIdempotencyStore({ maxEntries: 2 });
    await store.begin("a", "fp");
    await store.begin("b", "fp");
    await store.begin("c", "fp");
    await expect(store.begin("a", "fp")).resolves.toMatchObject({ status: "new" });
    await expect(store.begin("c", "fp")).resolves.toEqual({ status: "in_flight" });
  });

  it("refuses TTLs and caps that are not positive integers", () => {
    expect(() => createMemoryIdempotencyStore({ ttlMs: 0 })).toThrow(/positive whole number/);
    expect(() => createMemoryIdempotencyStore({ inFlightTtlMs: 0.5 })).toThrow(/positive whole number/);
    expect(() => createMemoryIdempotencyStore({ maxEntries: 0 })).toThrow(/maxEntries/);
  });
});
