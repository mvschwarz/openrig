// Slice 26.B HG-8 mobile-drawer-layering regression (OPT-B repair).
//
// Pre-repair: opaque-mode Explorer mobile drawer rendered at z-20
// while the AppShell mobile-rail-tray rendered at z-30. Both attach
// at left-0 on mobile and share `explorerOpen` state, so they
// overlap geometrically. The rail-tray covered the Explorer; click
// hits registered on rail items, not Explorer items. velocity-qa
// caught this at 375px for Settings (the 5th Explorer-bearing
// destination); pre-existing bug exposed by slice 26.
//
// Repair: bump opaque-mode Explorer to z-40 so it layers above
// rail-tray (z-30) on mobile. Overlay-mode (Topology graph) stays
// z-30 — equal to rail-tray; DOM render order resolves Explorer
// above since AppShell renders the Explorer aside AFTER the
// rail-tray.
//
// Cross-destination scope: the change in Explorer.tsx applies to
// all 5 Explorer-bearing destinations (Topology, Project, Library,
// For-You, Settings). Tests verify the className contract across
// surfaces so the cross-destination fix is exercised.

import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { Explorer, shouldSuppressExplorerMount } from "../src/components/Explorer.js";
import type { ExplorerSurface } from "../src/components/Explorer.js";
import { createAppTestRouter } from "./helpers/test-router.js";

afterEach(() => {
  cleanup();
});

function renderExplorerAt(surface: ExplorerSurface, initialPath: string) {
  return render(
    createAppTestRouter({
      initialPath,
      routes: [
        {
          path: initialPath,
          component: () => (
            <Explorer
              open={true}
              onClose={() => {}}
              selection={null}
              onSelect={() => {}}
              desktopMode="full"
              surface={surface}
              overlayMode="opaque"
            />
          ),
        },
      ],
    }),
  );
}

const MOBILE_RAIL_TRAY_Z = 30; // packages/ui/src/components/AppShell.tsx L560
const EXPLORER_REPAIRED_OPAQUE_Z = 40; // slice 26.B HG-8 OPT-B bumped value

describe("Explorer mobile drawer z-index layering (slice 26.B HG-8 OPT-B repair)", () => {
  // CROSS-DESTINATION assertion: the Explorer.tsx z-index change
  // applies to ALL Explorer-bearing surfaces — verifying for each
  // proves the fix is structural, not surface-specific.
  const opaqueSurfaces: ExplorerSurface[] = ["project", "specs", "for-you", "settings"];

  for (const surface of opaqueSurfaces) {
    describe(`surface=${surface} (opaque-mode)`, () => {
      it(`Explorer aside has z-40 class (above mobile-rail-tray z-30) — POSITIVE assertion`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // Repaired class contract: z-40 is present
        expect(explorer.className).toMatch(/\bz-40\b/);
      });

      it(`Explorer aside does NOT have z-20 class — NEGATIVE assertion (pre-repair broken value absent)`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // Pre-repair broken value: z-20 must NOT appear; would
        // re-introduce the rail-tray-covers-Explorer bug
        expect(explorer.className).not.toMatch(/\bz-20\b/);
      });

      it(`Explorer aside z-index value is numerically greater than mobile-rail-tray z-index (${MOBILE_RAIL_TRAY_Z})`, async () => {
        renderExplorerAt(surface, "/path-for-test");
        await waitFor(() => {
          expect(screen.getByTestId("explorer")).toBeTruthy();
        });
        const explorer = screen.getByTestId("explorer");
        // Discriminating layering invariant: pull the z-N class and
        // verify N > rail-tray-z. Without the repair this would be 20.
        const zMatch = explorer.className.match(/\bz-(\d+)\b/);
        expect(zMatch).toBeTruthy();
        const explorerZ = Number(zMatch![1]);
        expect(explorerZ).toBeGreaterThan(MOBILE_RAIL_TRAY_Z);
        expect(explorerZ).toBe(EXPLORER_REPAIRED_OPAQUE_Z);
      });
    });
  }

  describe("surface=topology (overlay-mode preserved)", () => {
    it("overlay-mode Explorer retains z-30 (Topology graph canvas float behavior)", async () => {
      render(
        createAppTestRouter({
          initialPath: "/topology",
          routes: [
            {
              path: "/topology",
              component: () => (
                <Explorer
                  open={true}
                  onClose={() => {}}
                  selection={null}
                  onSelect={() => {}}
                  desktopMode="full"
                  surface="topology"
                  overlayMode="overlay"
                />
              ),
            },
          ],
        }),
      );
      await waitFor(() => {
        expect(screen.getByTestId("explorer")).toBeTruthy();
      });
      const explorer = screen.getByTestId("explorer");
      expect(explorer.className).toMatch(/\bz-30\b/);
      // Overlay mode: z-30 equals mobile-rail-tray z-30 — DOM render
      // order resolves Explorer above (AppShell renders Explorer
      // aside AFTER the rail-tray div). This is the same layer that
      // worked correctly before slice 26 for Topology graph; not
      // changed by this repair.
    });
  });

});

// Slice 26.D OPT-D3 Topology mobile Explorer mount-suppression.
//
// OPT-C3 z-index carve-out was invalidated by velocity-qa recheck:
// z-index suppresses visibility but NOT React MOUNT. The peg trigger
// is the Explorer drawer MOUNTING on hamburger click, which causes
// adjacent Topology re-render cascade — independent of whether the
// drawer is visible. OPT-D3 suppresses the mount itself for Topology
// at narrow viewports. Pure predicate; trivially testable.

describe("shouldSuppressExplorerMount (slice 26.D OPT-D3 mount-suppression predicate)", () => {
  it("Topology + narrow viewport (isWideLayout=false) → SUPPRESS mount (true)", () => {
    expect(shouldSuppressExplorerMount("topology", false)).toBe(true);
  });

  it("Topology + wide viewport (isWideLayout=true) → mount normally (false)", () => {
    expect(shouldSuppressExplorerMount("topology", true)).toBe(false);
  });

  // Cross-destination preservation: all 4 other Explorer-bearing
  // surfaces mount regardless of viewport. The carve-out is
  // Topology-specific.
  const otherSurfaces: ExplorerSurface[] = ["settings", "project", "specs", "for-you"];
  for (const surface of otherSurfaces) {
    it(`${surface} + narrow viewport → mount normally (false)`, () => {
      expect(shouldSuppressExplorerMount(surface, false)).toBe(false);
    });
    it(`${surface} + wide viewport → mount normally (false)`, () => {
      expect(shouldSuppressExplorerMount(surface, true)).toBe(false);
    });
  }

  it("'none' surface → never suppressed (consistent with Explorer not mounting anyway via explorerVisible gate)", () => {
    expect(shouldSuppressExplorerMount("none", false)).toBe(false);
    expect(shouldSuppressExplorerMount("none", true)).toBe(false);
  });
});
