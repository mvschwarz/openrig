import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Quote an exact address entry in the authored forwarding table; never resolve or rewrite a target. */
export function recordedSuccessorNotice(topologyRoot: string, destination: string): string {
  const unavailable = "Recorded successor unknown: the forwarding ledger is unavailable or ambiguous.";
  const unrecorded = "Successor unrecorded in the forwarding ledger.";
  let fd: number | undefined;
  try {
    fd = openSync(join(topologyRoot, "FORWARDING.md"), constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return unavailable;
    const lines = readFileSync(fd, "utf8").split(/\r?\n/);
    const cells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")
      .map(value => value.trim().replace(/^`([^`]+)`$/, "$1"));
    const header = lines.findIndex(line => {
      const row = cells(line).map(value => value.toLowerCase().replace(/["']/g, ""));
      return row.length === 4 && row[0] === "old address" && row[1] === "new owner (or retired)"
        && row[2] === "date" && row[3] === "decided by";
    });
    if (header < 0) return unavailable;
    const matches: string[][] = [];
    for (const line of lines.slice(header + 1)) {
      if (!line.trim()) break;
      const row = cells(line);
      if (row.length === 4 && row.every(value => /^:?-{3,}:?$/.test(value))) continue;
      if (row.length !== 4 || row.some(value => !value)) return unavailable;
      if (row[0] === destination) matches.push(row);
    }
    if (!matches.length) return unrecorded;
    if (matches.length !== 1) return unavailable;
    const [, owner, date, decidedBy] = matches[0]!;
    return `Recorded successor: ${JSON.stringify(owner)} (date ${JSON.stringify(date)}, decided by ${JSON.stringify(decidedBy)}).`;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? unrecorded : unavailable;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
