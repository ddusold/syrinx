import { describe, expect, it } from "vitest";
import { checkParity, type Outcome, type SyrinxClient } from "./index.js";

const fake = (surface: string, outcome: Outcome): SyrinxClient => ({
  surface,
  invoke: () => Promise.resolve(outcome),
  read: () => Promise.resolve(outcome),
});

describe("checkParity", () => {
  it("reports surfaces whose outcome differs", async () => {
    const { differences } = await checkParity(
      [fake("a", { status: "complete", data: { n: 1 } }), fake("b", { status: "complete", data: { n: 2 } })],
      (c) => c.invoke("x", "y", {}),
    );
    expect(differences).toHaveLength(1);
    expect(differences[0]).toMatch(/^b: .* differs from a:/);
  });

  it("ignores request state bytes and error wording, but not error kinds or field paths", async () => {
    const asked = (requestState: string): Outcome => ({
      status: "input_required",
      inputRequests: { "input-0": { kind: "confirm", message: "Sure?" } },
      requestState,
    });
    const error = (kind: "validation" | "conflict", message: string, path: string): Outcome => ({
      status: "error",
      kind,
      message,
      issues: [{ path, message }],
    });
    const call = (c: SyrinxClient) => c.invoke("x", "y", {});

    expect((await checkParity([fake("a", asked("s1")), fake("b", asked("s2"))], call)).differences).toEqual([]);
    expect(
      (
        await checkParity(
          [fake("a", error("validation", "bad", "id")), fake("b", error("validation", "Bad!", "id"))],
          call,
        )
      ).differences,
    ).toEqual([]);
    expect(
      (await checkParity([fake("a", error("validation", "x", "id")), fake("b", error("conflict", "x", "id"))], call))
        .differences,
    ).toHaveLength(1);
    expect(
      (
        await checkParity(
          [fake("a", error("validation", "x", "id")), fake("b", error("validation", "x", "name"))],
          call,
        )
      ).differences,
    ).toHaveLength(1);
  });
});
