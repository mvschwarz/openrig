import { randomUUID } from "node:crypto";
import { link, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Command, InvalidArgumentError, Option } from "commander";
import { z } from "zod";
import type { DaemonResponse } from "../client.js";

type Request = (call: {
  readonly path: string; readonly host?: string; readonly body?: object;
}) => Promise<DaemonResponse | undefined>;
type Output = { readonly out?: string; readonly json?: boolean; readonly dryRun?: boolean };
type Intervention = { readonly actor: string; readonly intervention: string; readonly limits?: string; readonly out: string };
type ArchiveAuth = { readonly archive: string; readonly authorization: string };
type WithHost = { readonly host?: string };
const base = "/api/queue-transfer";
const stageResponse = z.object({ stage: z.object({ digest: z.string(), origin: z.object({ hostId: z.string(), mintedAt: z.string() }) }), destinationHostId: z.string() });
const receiptResponse = z.object({ receipt: z.json() });

const jsonFile = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

function pair(value: string) {
  const split = value.indexOf("=");
  if (split < 1 || !value.slice(split + 1).trim()) throw new InvalidArgumentError(`Expected name=value, got ${value}`);
  return [value.slice(0, split), value.slice(split + 1)] as const;
}

async function writeRecord(path: string, record: unknown) {
  const { canonicalQueueJson } = await import("@openrig/daemon/queue-transfer-records");
  const out = resolve(path);
  const temporary = await mkdtemp(join(dirname(out), ".queue-transfer-"));
  try {
    const file = join(temporary, "record");
    await writeFile(file, `${canonicalQueueJson(z.json().parse(record))}\n`, { mode: 0o600, flag: "wx" });
    await link(file, out);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function print(data: unknown, compact?: boolean) {
  process.stdout.write(`${JSON.stringify(data, null, compact ? undefined : 2)}\n`);
}

function accepted(response: DaemonResponse | undefined, compact?: boolean): response is DaemonResponse {
  if (!response) return false;
  if (response.status >= 200 && response.status < 300) return true;
  print(response.data, compact);
  process.exitCode = 2;
  return false;
}

async function render(response: DaemonResponse | undefined, opts: Output = {}, unwrapReceipt = false) {
  if (!accepted(response, opts.json)) return;
  print(response.data, opts.json);
  if (!opts.dryRun && opts.out) await writeRecord(opts.out, unwrapReceipt ? receiptResponse.parse(response.data).receipt : response.data);
}

function interventionOptions(command: Command) {
  return command.requiredOption("--actor <name>", "Operator recording the intervention")
    .requiredOption("--intervention <text>", "What was stopped or isolated")
    .requiredOption("--out <file>", "Write a new private record");
}

function archiveAuthOptions(command: Command) {
  return command.requiredOption("--archive <file>", "Source archive").requiredOption("--authorization <file>", "Destination authorization");
}

function hostOption(command: Command) {
  return command.option("--host <registered host>", "Call the registered host's daemon directly");
}

function outputOptions(command: Command) {
  return command.option("--out <file>", "Write a new private record").option("--json", "Print compact JSON");
}

export function queueTransferCommand(request: Request): Command {
  const cmd = new Command("transfer").description("Authorize, activate and reconcile an inactive queue import");

  interventionOptions(cmd.command("authorize <importId>").description("Write authorization from a destination staging manifest"))
    .addOption(new Option("--intervention-kind <kind>", "How the source will be restricted").choices(["online-handshake", "operator-attestation"]).makeOptionMandatory())
    .option("--limits <text>", "Limits of the intervention")
    .option("--map <from=to...>", "Map live routes to local seats")
    .option("--disposition <qitemId=text...>", "Specify a blocked row's continuation")
    .action(async (importId: string, opts: Intervention & { interventionKind: string; map?: string[]; disposition?: string[] }) => {
      const seatMapping = (opts.map ?? []).map(value => { const [from, to] = pair(value); return { from, to }; });
      const dispositions = opts.disposition?.map(value => { const [qitemId, text] = pair(value); return { qitemId, text }; });
      if (!opts.intervention.trim()) throw new InvalidArgumentError("--intervention must describe the intervention");
      const response = await request({ path: `${base}/staging/${encodeURIComponent(importId)}` });
      if (!accepted(response)) return;
      const { stage, destinationHostId } = stageResponse.parse(response.data);
      const { AUTHORIZATION_KIND, parseAuthorization } = await import("@openrig/daemon/queue-transfer-records");
      const now = new Date().toISOString();
      const record = parseAuthorization({ kind: AUTHORIZATION_KIND, operationId: randomUUID(), archiveDigest: stage.digest, origin: stage.origin,
        destination: { hostId: destinationHostId, authorizedAt: now, seatMapping }, ...(dispositions ? { dispositions } : {}),
        intervention: { kind: opts.interventionKind, actor: opts.actor, recordedAt: now, limits: opts.limits ?? "" } });
      await writeRecord(opts.out, record);
    });

  hostOption(archiveAuthOptions(interventionOptions(cmd.command("relinquish").description("Ask the source to fence the current archive selection"))))
    .option("--limits <text>", "Limits of the intervention").option("--dry-run", "Check the source without fencing or writing a receipt")
    .action(async (opts: Intervention & ArchiveAuth & WithHost & Output) => render(await request({ path: `${base}/relinquish`, host: opts.host, body: {
      archiveText: await readFile(opts.archive, "utf8"), authorization: await jsonFile(opts.authorization), actor: opts.actor,
      intervention: opts.intervention, limits: opts.limits, dryRun: opts.dryRun,
    } }), opts, true));

  archiveAuthOptions(interventionOptions(cmd.command("attest").description("Write an isolation receipt for an unreachable source")))
    .requiredOption("--limits <text>", "Limits of the isolation")
    .action(async (opts: Intervention & ArchiveAuth & { readonly limits: string }) => {
      const records = await import("@openrig/daemon/queue-transfer-records");
      const archive = records.parseQueueTransfer(await readFile(opts.archive, "utf8"));
      const authorization = records.parseAuthorization(await jsonFile(opts.authorization));
      const hostId = authorization.destination.hostId;
      records.assertAuthorization(archive, authorization, hostId);
      if (authorization.intervention.kind !== "operator-attestation") throw new InvalidArgumentError("Authorization must name operator-attestation");
      if (!opts.limits.trim()) throw new InvalidArgumentError("--limits must describe the limits of source isolation");
      const selection = records.transferSelection(archive);
      const receipt = records.parseReceipt({ kind: records.RECEIPT_KIND, transferId: archive.transferId, archiveDigest: archive.digest,
        authorizationDigest: records.authorizationDigest(authorization), origin: archive.origin,
        destination: { hostId, mappingDigest: records.mappingDigest(authorization.destination.seatMapping) }, sourceState: "isolated",
        method: "operator-attestation", intervention: opts.intervention, limits: opts.limits, recordedAt: new Date().toISOString(),
        actor: opts.actor, rowsDigest: records.rowsDigest(selection), selection, workflowState: [], note: "Source workflow state is unknown." });
      await writeRecord(opts.out, receipt);
    });

  outputOptions(cmd.command("activate <importId>").description("Activate an authorized stage on the destination"))
    .requiredOption("--authorization <file>").requiredOption("--receipt <file>", "Source relinquishment or isolation receipt")
    .option("--actor <name>", "Declared operator outside a managed seat").option("--dry-run", "Check readiness without activating")
    .action(async (importId: string, opts: Output & { authorization: string; receipt: string; actor?: string }) => render(await request({
      path: `${base}/activate`, body: { importId, authorization: await jsonFile(opts.authorization), receipt: await jsonFile(opts.receipt), actor: opts.actor, dryRun: opts.dryRun },
    }), opts));

  hostOption(outputOptions(cmd.command("reconcile").description("Reconcile the source against the destination activation result")))
    .requiredOption("--archive <file>").requiredOption("--receipt <file>", "Destination activation result, not the source receipt")
    .option("--actor <name>", "Declared operator outside a managed seat")
    .action(async (opts: Output & WithHost & { archive: string; receipt: string; actor?: string }) => render(await request({
      path: `${base}/reconcile`, host: opts.host, body: { archiveText: await readFile(opts.archive, "utf8"), result: await jsonFile(opts.receipt), actor: opts.actor },
    }), opts));

  hostOption(cmd.command("replay <file>").description("Replay a portable record after a restore"))
    .action(async (file: string, opts: WithHost) => render(await request({ path: `${base}/replay`, host: opts.host, body: { record: await jsonFile(file) } })));

  hostOption(cmd.command("status").description("Read the selected daemon's transfer ledger"))
    .option("--archive <file>", "Filter by the verified digest of this archive").option("--json", "Print compact JSON")
    .action(async (opts: Output & WithHost & { archive?: string }) => {
      const query = opts.archive ? `?archiveDigest=${(await import("@openrig/daemon/queue-transfer-records"))
        .parseQueueTransfer(await readFile(opts.archive, "utf8")).digest}` : "";
      await render(await request({ path: `${base}/status${query}`, host: opts.host }), opts);
    });
  return cmd;
}
