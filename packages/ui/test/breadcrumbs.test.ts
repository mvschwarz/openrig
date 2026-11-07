// ui-redesign C07: one case per route-table row (plus the percent-encoded
// logical-id case). Verifies labels, link targets, and that the last
// crumb never carries `to`. Expectations are table-driven so the case
// list itself is the spec — no repeated assertion blocks.

import { describe, expect, it } from "vitest";
import { breadcrumbsFor, type Crumb } from "../src/lib/breadcrumbs.js";

const names = { rigName: (id: string) => (id === "rig_alpha" ? "acme-build" : undefined) };

const RIG = (id = "rig_alpha"): Crumb[] => [
  { label: "Rigs", to: "/topology" },
  { label: names.rigName(id) ?? id },
];

const RIG_TAIL = (id: string, tail: string): Crumb[] => [...RIG(id).slice(0, 1), { label: names.rigName(id) ?? id, to: `/topology/rig/${id}` }, { label: tail }];

const CASES: Array<[path: string, crumbs: Crumb[]]> = [
  ["/", [{ label: "Dashboard" }]],
  ["/for-you", [{ label: "Inbox" }]],
  ["/topology", [{ label: "Rigs" }]],
  ["/topology/rig/rig_alpha", RIG()],
  ["/topology/rig/rig_unknown", RIG("rig_unknown")],
  ["/topology/pod/rig_alpha/lead", RIG_TAIL("rig_alpha", "lead pod")],
  ["/topology/seat/rig_alpha/lead.coordinator", RIG_TAIL("rig_alpha", "coordinator")],
  ["/topology/seat/rig_alpha/lead%2Ecoordinator", RIG_TAIL("rig_alpha", "coordinator")],
  ["/rigs/rig_alpha", RIG()],
  ["/rigs/rig_alpha/nodes/lead.coordinator", RIG_TAIL("rig_alpha", "coordinator")],
  ["/agents", [{ label: "Agents" }]],
  ["/fleet", [{ label: "Hosts" }]],
  ["/workflows", [{ label: "Workflows" }]],
  ["/workflow/instance/abc123", [{ label: "Workflows", to: "/workflows" }, { label: "abc123" }]],
  ["/project", [{ label: "Projects" }]],
  ["/project/mission/m1", [{ label: "Projects", to: "/project" }, { label: "Mission m1" }]],
  ["/project/slice/s9", [{ label: "Projects", to: "/project" }, { label: "Slice s9" }]],
  ["/specs", [{ label: "Library" }]],
  ["/specs/skills", [{ label: "Library", to: "/specs" }, { label: "Skills" }]],
  ["/specs/skills/build", [{ label: "Library", to: "/specs" }, { label: "Skills", to: "/specs/skills" }, { label: "build" }]],
  ["/specs/plugins", [{ label: "Library", to: "/specs" }, { label: "Plugins" }]],
  [
    "/plugins/my-plugin",
    [{ label: "Library", to: "/specs" }, { label: "Plugins", to: "/specs/plugins" }, { label: "my-plugin" }],
  ],
  ["/specs/applications", [{ label: "Library", to: "/specs" }, { label: "applications" }]],
  ["/specs/rig", [{ label: "Library", to: "/specs" }, { label: "rig" }]],
  ["/files", [{ label: "Files" }]],
  ["/settings", [{ label: "Settings" }]],
  ["/settings/policies", [{ label: "Settings", to: "/settings" }, { label: "Policies" }]],
  ["/settings/log", [{ label: "Settings", to: "/settings" }, { label: "Log" }]],
  ["/settings/status", [{ label: "Settings", to: "/settings" }, { label: "Status" }]],
  ["/bootstrap", [{ label: "Bootstrap" }]],
  ["/import", [{ label: "Import" }]],
  ["/packages", [{ label: "Packages" }]],
  ["/search", [{ label: "Search" }]],
  ["/packages/install", [{ label: "Packages", to: "/packages" }, { label: "Install" }]],
  ["/packages/my-pack", [{ label: "Packages", to: "/packages" }, { label: "my-pack" }]],
  [
    "/specs/skills/developing-openrig/file/SKILL.md",
    [
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "developing-openrig", to: "/specs/skills/developing-openrig" },
      { label: "SKILL.md" },
    ],
  ],
  [
    "/specs/skills/build/file/scripts/test.py",
    [
      { label: "Library", to: "/specs" },
      { label: "Skills", to: "/specs/skills" },
      { label: "build", to: "/specs/skills/build" },
      { label: "scripts/test.py" },
    ],
  ],
  [
    "/topology/seat/rig_alpha/lead.coordinator/logs",
    [
      { label: "Rigs", to: "/topology" },
      { label: "acme-build", to: "/topology/rig/rig_alpha" },
      { label: "coordinator", to: "/topology/seat/rig_alpha/lead.coordinator" },
      { label: "logs" },
    ],
  ],
  ["/some/unknown%20page", [{ label: "unknown page" }]],
  ["/lab/card-previews", [{ label: "card-previews" }]],
  ["/lab/a/b/c", [{ label: "c" }]],
];

describe("breadcrumbs", () => {
  it.each(CASES)("%s", (path, expected) => {
    expect(breadcrumbsFor(path, names)).toEqual(expected);
  });

  it("never puts `to` on the last crumb", () => {
    for (const [path] of CASES) {
      const crumbs = breadcrumbsFor(path, names);
      expect(crumbs.length).toBeGreaterThan(0);
      expect(crumbs[crumbs.length - 1]).not.toHaveProperty("to");
    }
  });
});
