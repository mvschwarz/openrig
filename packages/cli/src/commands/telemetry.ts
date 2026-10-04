import { Command } from "commander";
import { DaemonClient } from "../client.js";
import { getDaemonStatus, getDaemonUrl, daemonStatusGuard } from "../daemon-lifecycle.js";
import { realDeps } from "./daemon.js";
import type { StatusDeps } from "./status.js";
interface ReadOptions {
    cursor?: string;
    start?: string;
    limit?: string;
    node?: string;
    rig?: string;
    qitem?: string;
    json?: boolean;
}
interface Page {
    stream: string;
    rows: unknown[];
    page: {
        scanned: number;
        returned: number;
        through: string;
        hasMore: boolean;
        nextCursor: string | null;
        restartCursor: string | null;
    };
    coverage: {
        status: string;
        gaps: Array<{
            code: string;
        }>;
        gapCount: number;
    };
}
/** Thin, single-page consumer: a printed cursor is never automatically followed. */
export function telemetryCommand(depsOverride?: StatusDeps): Command {
    const command = new Command("telemetry").description("Read one bounded page of retained metadata, with explicit history gaps");
    const read = async (path: string, opts: ReadOptions) => {
        const deps = depsOverride ?? { lifecycleDeps: realDeps(), clientFactory: (url: string) => new DaemonClient(url) };
        const daemon = await getDaemonStatus(deps.lifecycleDeps);
        if (!daemonStatusGuard(daemon))
            return;
        const params = new URLSearchParams();
        for (const [key, value] of Object.entries({ cursor: opts.cursor, start: opts.start, limit: opts.limit, nodeId: opts.node, rigId: opts.rig, qitemId: opts.qitem })) {
            if (value !== undefined)
                params.set(key, value);
        }
        const response = await deps.clientFactory(getDaemonUrl(daemon)).get<Page & {
            error?: string;
        }>(`/api/telemetry/v1/${path}?${params.toString()}`);
        if (opts.json)
            console.log(JSON.stringify(response.data, null, 2));
        else if (response.status >= 400)
            console.error(response.data.error ?? "Telemetry read unavailable");
        else {
            const { rows, page, coverage } = response.data;
            console.log(`${response.data.stream}: ${page.returned} returned, ${page.scanned} scanned; coverage ${coverage.status}; through ${page.through}`);
            for (const row of rows)
                console.log(JSON.stringify(row));
            for (const entry of coverage.gaps)
                console.log(`Gap: ${entry.code}`);
            if (coverage.gapCount > coverage.gaps.length)
                console.log(`Additional gaps: ${coverage.gapCount - coverage.gaps.length}`);
            if (page.hasMore)
                console.log("More retained metadata remains; this command read one page.");
            if (page.nextCursor)
                console.log(`Next cursor: ${page.nextCursor}`);
            if (page.restartCursor)
                console.log(`Fresh-start cursor (previous history unverified): ${page.restartCursor}`);
        }
        if (response.status >= 400)
            process.exitCode = response.status >= 500 ? 2 : 1;
    };
    const paging = (cmd: Command) => cmd.option("--cursor <token>", "Opaque cursor from this stream and filter")
        .option("--limit <n>", "Source-row cap, at most 128")
        .option("--json", "Return the complete versioned page and coverage envelope");
    paging(command.command("events").description("Event metadata only; no payload content"))
        .option("--start <mode>", "latest (default) or retained, for a new window")
        .option("--node <id>", "Filter the bounded source page by immutable node ID")
        .option("--rig <id>", "Filter the bounded source page by immutable rig ID")
        .action((opts: ReadOptions) => read("events", opts));
    paging(command.command("transitions").description("Active and archived queue-transition metadata"))
        .option("--start <mode>", "latest (default) or retained, for a new window")
        .option("--qitem <id>", "Filter the bounded source page by exact queue item ID")
        .action((opts: ReadOptions) => read("queue-transitions", opts));
    paging(command.command("tenures").argument("<node-id>").description("Newest retained occupant tenures for one immutable node (default 32)"))
        .action((node: string, opts: ReadOptions) => read(`nodes/${encodeURIComponent(node)}/tenures`, opts));
    return command;
}
