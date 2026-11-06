import { describeIdempotencyStore } from "@syrinx/testing/stores";
import { createMemoryIdempotencyStore } from "./idempotency.js";

describeIdempotencyStore("memory", (timings) => createMemoryIdempotencyStore(timings));
