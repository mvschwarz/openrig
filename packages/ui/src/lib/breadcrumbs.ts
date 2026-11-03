// ui-redesign C07: pathname (+ optional rig names) -> breadcrumb trail.
// First match wins on the card's route table; the last crumb never
// carries `to`. Every segment is decodeURIComponent'd inside try/catch.

import { displayAgentName } from "./display-name.js";

export interface Crumb {
  label: string;
  to?: string;
}

export interface CrumbNames {
  rigName?: (rigId: string) => string | undefined;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function segsOf(pathname: string): string[] {
  return pathname.split("/").filter((s) => s.length > 0).map(decode);
}

/** Link every crumb but the last (the current page is never a link). */
function linked(pairs: Array<[label: string, to?: string]>): Crumb[] {
  return pairs.map(([label, to], i) => (i < pairs.length - 1 && to ? { label, to } : { label }));
}

/** `[Rigs→/topology, <name>]`, optionally with a linked rig middle crumb + tail. */
function rigCrumbs(rigId: string, rigLabel: string, tail?: string): Crumb[] {
  const pairs: Array<[string, string?]> =
    tail === undefined
      ? [
          ["Rigs", "/topology"],
          [rigLabel],
        ]
      : [
          ["Rigs", "/topology"],
          [rigLabel, `/topology/rig/${rigId}`],
          [tail],
        ];
  return linked(pairs);
}

export function breadcrumbsFor(pathname: string, names?: CrumbNames): Crumb[] {
  const segs = segsOf(pathname);
  const at = (i: number): string => segs[i] ?? "";
  const rigName = (rigId: string): string => names?.rigName?.(rigId) ?? rigId;

  if (segs.length === 0) return [{ label: "Dashboard" }];

  if (segs.length === 1) {
    switch (segs[0]) {
      case "for-you":
        return [{ label: "Inbox" }];
      case "topology":
        return [{ label: "Rigs" }];
      case "agents":
        return [{ label: "Agents" }];
      case "fleet":
        return [{ label: "Hosts" }];
      case "workflows":
        return [{ label: "Workflows" }];
      case "project":
        return [{ label: "Projects" }];
      case "specs":
        return [{ label: "Library" }];
      case "files":
        return [{ label: "Files" }];
      case "settings":
        return [{ label: "Settings" }];
      default:
        return [{ label: segs[0]! }];
    }
  }

  if (segs.length === 2) {
    if (at(0) === "rigs") return rigCrumbs(at(1), rigName(at(1)));
    if (at(0) === "specs" && at(1) === "skills") return linked([["Library", "/specs"], ["Skills"]]);
    if (at(0) === "specs" && at(1) === "plugins")
      return linked([
        ["Library", "/specs"],
        ["Plugins"],
      ]);
    if (at(0) === "plugins") {
      return linked([
        ["Library", "/specs"],
        ["Plugins", "/specs/plugins"],
        [at(1)],
      ]);
    }
    if (at(0) === "settings") {
      const labels: Record<string, string> = { policies: "Policies", log: "Log", status: "Status" };
      const label = labels[at(1)];
      if (label) return linked([["Settings", "/settings"], [label]]);
    }
    if (at(0) === "specs") return linked([["Library", "/specs"], [at(1)]]);
    return [{ label: at(1) }];
  }

  if (segs.length === 3) {
    if (at(0) === "topology" && at(1) === "rig") return rigCrumbs(at(2), rigName(at(2)));
    if (at(0) === "workflow" && at(1) === "instance") {
      return linked([
        ["Workflows", "/workflows"],
        [at(2)],
      ]);
    }
    if (at(0) === "project" && at(1) === "mission") {
      return linked([
        ["Projects", "/project"],
        [`Mission ${at(2)}`],
      ]);
    }
    if (at(0) === "project" && at(1) === "slice") {
      return linked([
        ["Projects", "/project"],
        [`Slice ${at(2)}`],
      ]);
    }
    // `/specs/skills/:t` -> `[Library, Skills→/specs/skills, :t]`
    // (Library itself is NOT a link there, per the card table).
    if (at(0) === "specs" && at(1) === "skills") {
      return [{ label: "Library" }, { label: "Skills", to: "/specs/skills" }, { label: at(2) }];
    }
    if (at(0) === "specs") return linked([["Library", "/specs"], [at(2)]]);
    return [{ label: at(2) }];
  }

  if (segs.length === 4) {
    if (at(0) === "topology" && at(1) === "pod") {
      return rigCrumbs(at(2), rigName(at(2)), `${at(3)} pod`);
    }
    if (at(0) === "topology" && at(1) === "seat") {
      return rigCrumbs(at(2), rigName(at(2)), displayAgentName(at(3)));
    }
    if (at(0) === "rigs" && at(2) === "nodes") {
      return rigCrumbs(at(1), rigName(at(1)), displayAgentName(at(3)));
    }
    if (at(0) === "specs") return linked([["Library", "/specs"], [at(3)]]);
    return [{ label: at(3) }];
  }

  // Anything deeper: last decoded segment.
  return [{ label: segs[segs.length - 1]! }];
}
