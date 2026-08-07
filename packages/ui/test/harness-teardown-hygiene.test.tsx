// UI HARNESS TEARDOWN HYGIENE — the R5-family "work must not outlive its
// context" pattern, in the React harness.
//
// THE DEFECT (desk-caught, main c230909cf): the full ui run reported
// "Errors 1" with a fully GREEN test count — ReferenceError: window is not
// defined at react-dom performWorkOnRootViaSchedulerTask, thrown AFTER the
// test environment was torn down. Vitest's own warning: an unhandled
// post-teardown error can cause FALSE POSITIVE tests, and it flips the exit
// code that gates the A/B pin.
//
// THE STRUCTURAL CAUSE (verified at source): vitest.config.ts does not set
// `globals`, so it defaults FALSE — and React Testing Library only registers
// its automatic `afterEach(cleanup)` when the framework's afterEach is
// available as a global. With globals:false that auto-cleanup NEVER RUNS, so
// every test file that does not call cleanup itself (117 of 153 at the time
// of writing) leaves its React tree MOUNTED past the test. A mounted tree can
// still have scheduled work (React schedules through its own task queue); if
// that task lands after the environment is disposed, it dereferences a
// `window` that no longer exists. The components are innocent — e.g.
// TerminalPreviewPopover already cancels its rAF in the effect cleanup — but
// that cleanup only runs ON UNMOUNT, which never happens.
//
// THE FIX: register cleanup globally in test/setup.ts, so every test unmounts
// its tree (cancelling pending work) rather than suppressing the error.
//
// This file pins the PRECONDITION deterministically: with the fix, a test
// that renders leaves nothing behind for the next test. Without it, the leak
// is visible — which is the same leak that lets work outlive the environment.
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";

describe("ui harness: every test unmounts its tree (global auto-cleanup registered)", () => {
  it("renders a probe tree and does NOT unmount it explicitly", () => {
    render(<div data-testid="teardown-hygiene-probe">probe</div>);
    expect(document.querySelectorAll("[data-testid='teardown-hygiene-probe']").length).toBe(1);
  });

  it("the NEXT test starts with a clean DOM — the previous tree was unmounted by the harness", () => {
    // RED without a global afterEach(cleanup): the probe from the previous
    // test is still mounted here, and (crucially) so is every other suite's
    // tree in a full run — the population whose scheduled work outlives the
    // environment.
    expect(document.querySelectorAll("[data-testid='teardown-hygiene-probe']").length).toBe(0);
    expect(document.body.innerHTML).toBe("");
  });
});
