import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import Database from "better-sqlite3";
import { Hono } from "hono";
import { telemetryRoutes } from "../../daemon/src/routes/telemetry.js";
import { eventsSchema } from "../../daemon/src/db/migrations/003_events.js";
import { telemetryCommand } from "../src/commands/telemetry.js";
import { STATE_FILE } from "../src/daemon-lifecycle.js";
import type { StatusDeps } from "../src/commands/status.js";
const databases: Database.Database[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0))
    db.close(); });
async function run(args: string[], respond: (path: string) => Promise<{
    status: number;
    data: unknown;
}>) {
    const paths: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const saved = process.exitCode;
    vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.join(" ")); });
    const deps = {
        lifecycleDeps: {
            readFile: (path: string) => path === STATE_FILE ? JSON.stringify({ pid: 123, port: 17433, db: "fixture.sqlite", startedAt: "2026-10-04T09:00:00Z" }) : null,
            exists: (path: string) => path === STATE_FILE, isProcessAlive: () => true, fetch: async () => ({ ok: true }),
        },
        clientFactory: () => ({ get: async (path: string) => { paths.push(path); return respond(path); } }),
    } as unknown as StatusDeps;
    process.exitCode = undefined;
    try {
        await new Command().addCommand(telemetryCommand(deps)).parseAsync(["node", "rig", "telemetry", ...args]);
        return { paths, logs, errors, exit: process.exitCode };
    }
    finally {
        process.exitCode = saved;
    }
}
const envelope = {
    schemaVersion: 1, stream: "events", source: { bootEpoch: "boot", sequenceSpaceId: null },
    rows: [{ seq: "9007199254740993" }],
    page: { scanned: 128, returned: 1, through: "9007199254741000", hasMore: true, nextCursor: "next-token", restartCursor: null },
    coverage: { status: "partial", historyCompleteness: "unknown", gaps: [{ code: "retained_sequence_gap" }], gapCount: 1 },
};
describe("rig telemetry", () => {
    it("passes filters and cursor to one read and preserves the complete JSON envelope", async () => {
        const result = await run(["events", "--cursor", "cursor-token", "--limit", "17", "--node", "node-a", "--rig", "rig-a", "--json"], async () => ({ status: 200, data: envelope }));
        expect(result.paths).toHaveLength(1);
        const url = new URL(result.paths[0]!, "http://fixture");
        expect(url.pathname).toBe("/api/telemetry/v1/events");
        expect(Object.fromEntries(url.searchParams)).toEqual({ cursor: "cursor-token", limit: "17", nodeId: "node-a", rigId: "rig-a" });
        expect(JSON.parse(result.logs.join("\n"))).toEqual(envelope);
        expect(result.exit).toBeUndefined();
    });
    it("prints gaps and continuation explicitly, without draining another page", async () => {
        const result = await run(["events", "--start", "retained"], async () => ({ status: 200, data: envelope }));
        expect(result.paths).toHaveLength(1);
        expect(result.logs.join("\n")).toContain("Gap: retained_sequence_gap");
        expect(result.logs.join("\n")).toContain("Next cursor: next-token");
        expect(result.logs.join("\n")).toContain("this command read one page");
    });
    it("maps transition and tenure grammar without importing private database state", async () => {
        const transitions = await run(["transitions", "--start", "retained", "--qitem", "q-a", "--json"], async () => ({ status: 200, data: envelope }));
        expect(transitions.paths).toEqual(["/api/telemetry/v1/queue-transitions?start=retained&qitemId=q-a"]);
        const tenures = await run(["tenures", "node/a", "--limit", "32", "--json"], async () => ({ status: 200, data: envelope }));
        expect(tenures.paths).toEqual(["/api/telemetry/v1/nodes/node%2Fa/tenures?limit=32"]);
    });
    it.each([400, 503])("retains the HTTP %i error and nonzero exit", async (status) => {
        const body = { code: "telemetry_read_unavailable", error: "Unavailable" };
        const result = await run(["events", "--json"], async () => ({ status, data: body }));
        expect(result.exit).toBe(status === 400 ? 1 : 2);
        expect(JSON.parse(result.logs.join("\n"))).toEqual(body);
    });
    it("feeds actual Commander arguments through actual Hono/SQLite with the same bounded response", async () => {
        const db = new Database(":memory:");
        databases.push(db);
        db.exec(eventsSchema.sql);
        const insert = db.prepare("INSERT INTO events(node_id,type,payload) VALUES ('node-a','node.started','private')");
        db.transaction(() => { for (let i = 0; i < 5; i++)
            insert.run(); })();
        const app = new Hono().route("/api/telemetry", telemetryRoutes({ db: () => db, source: { hostId: "fixture", bootEpoch: "boot" } }));
        const result = await run(["events", "--start", "retained", "--limit", "2", "--node", "unmatched", "--json"], async (path) => {
            const response = await app.request(path);
            return { status: response.status, data: await response.json() };
        });
        expect(result.paths).toHaveLength(1);
        const body = JSON.parse(result.logs.join("\n"));
        expect(body.rows).toEqual([]);
        expect(body.page).toMatchObject({ scanned: 2, filtered: 2, lastScanned: "2", through: "5", hasMore: true });
        expect(body.coverage.historyCompleteness).toBe("unknown");
    });
});
