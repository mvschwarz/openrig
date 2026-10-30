import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import { allowOwnedHttpFixture } from "./helpers/owned-http-fixture.js";
import { resetFetchAllowlist } from "./fetch-guard.js";

afterEach(resetFetchAllowlist);

it("requires a bound server before registering any target", () => {
  expect(() => allowOwnedHttpFixture(createServer())).toThrow(/has not bound/);
});

it("registers only its bound loopback origin and keeps unrelated targets refused", async () => {
  const server = createServer((_request, response) => response.end("owned fixture"));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture did not bind");
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    if (address.port < 32768) await expect(fetch(origin)).rejects.toThrow(/FETCH GUARD/);
    allowOwnedHttpFixture(server);
    expect(await (await fetch(origin)).text()).toBe("owned fixture");
    const otherPort = address.port === 7433 ? 7434 : 7433;
    await expect(fetch(`http://127.0.0.1:${otherPort}/healthz`)).rejects.toThrow(/FETCH GUARD/);
    await expect(fetch("http://192.0.2.10:7433/healthz")).rejects.toThrow(/FETCH GUARD/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
