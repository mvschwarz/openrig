import { describe, expect, it, vi } from "vitest";

// `rig queue list` and `rig queue show` start by loading the queue command module (lazy-program.ts). zod is not part
// of that start-up: `queue transfer` loads it at its first parse.
vi.mock("zod", () => { throw new Error("zod was loaded with the queue command module"); });

describe("the queue command's start-up", () => {
  it("loads the queue command module and builds `rig queue`, transfer included, without loading zod", async () => {
    const { queueCommand } = await import("../src/commands/queue.js");
    const queue = queueCommand();
    expect(queue.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["list", "show", "transfer"]));
    const transfer = queue.commands.find((command) => command.name() === "transfer")!;
    expect(transfer.commands.map((command) => command.name())).toEqual(expect.arrayContaining(["authorize", "activate", "status"]));
  });
});
