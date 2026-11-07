import { describe, expect, it, vi } from "vitest";
import { logUnhandled, noopLogger } from "./context.js";

describe("logUnhandled", () => {
  it("swallows a failing logger, since it runs while an error response is built", () => {
    const logger = {
      ...noopLogger,
      error: () => {
        throw new Error("transport down");
      },
    };
    expect(() => {
      logUnhandled(logger, new Error("boom"));
    }).not.toThrow();
  });

  it("describes thrown values that cannot be turned into strings", () => {
    const error = vi.fn();
    logUnhandled({ ...noopLogger, error }, Object.create(null));
    expect(error).toHaveBeenCalledWith("unhandled error", expect.objectContaining({ "error.type": "object" }));
  });
});
