// R1 (release-0.4.7) — C4a: ProofTab empty-state copy mapping per useScopeMarkdown state.
//
// The `!populated` empty-state now branches on `proofMd.state`: an infra read
// failure and a mis-rooted scope get honest copies; a genuine absence keeps
// today's "NO PROOF YET" bytes EXACTLY (the byte-identity leg).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SliceProofTab } from "../src/components/project/ProofTab.js";

const mockFetch = vi.fn();
globalThis.fetch = mockFetch as unknown as typeof fetch;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

const SLICE = "/ws/missions/m/slices/s";
const SID = "OPR.TEST.1";

function renderProof(slicePath: string | null = SLICE) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SliceProofTab sliceId={SID} title="test slice" slicePath={slicePath} />
    </QueryClientProvider>,
  );
}

beforeEach(() => mockFetch.mockReset());
afterEach(() => cleanup());

describe("R1 C4a — ProofTab empty-state honest copy", () => {
  it("read_error → PROOF.MD READ FAILED (infra, not empty proof)", async () => {
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: "/ws" }] });
      if (url.includes("/api/files/read")) return json({ error: "boom" }, 500);
      if (url.includes("/api/files/list")) return json({ root: "work", path: "", entries: [] });
      return json([]);
    });
    renderProof();
    const el = await screen.findByTestId(`proof-read-error-${SID}`);
    expect(el.textContent).toContain("PROOF.MD READ FAILED");
    expect(el.textContent).toContain("this is a read failure, not an empty proof");
    // it must NOT show the genuine-absence copy
    expect(screen.queryByTestId(`proof-empty-state-${SID}`)).toBeNull();
  });

  it("unresolved (scope outside allowlist roots) → PROOF.MD OUTSIDE FILE ROOTS", async () => {
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/files/roots")) return json({ roots: [{ name: "other", path: "/elsewhere" }] });
      return json([]);
    });
    renderProof();
    const el = await screen.findByTestId(`proof-unresolved-${SID}`);
    expect(el.textContent).toContain("PROOF.MD OUTSIDE FILE ROOTS");
    expect(el.textContent).toContain("OPENRIG_FILES_ALLOWLIST");
    expect(screen.queryByTestId(`proof-empty-state-${SID}`)).toBeNull();
  });

  it("absent (404) → NO PROOF YET, BYTE-IDENTICAL to 8250d702", async () => {
    mockFetch.mockImplementation(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/files/roots")) return json({ roots: [{ name: "work", path: "/ws" }] });
      if (url.includes("/api/files/read")) return json({ error: "not found" }, 404);
      if (url.includes("/api/files/list")) return json({ root: "work", path: "", entries: [] });
      return json([]);
    });
    renderProof();
    const el = await screen.findByTestId(`proof-empty-state-${SID}`);
    // the pinned 8250d702 literals — label + full description, unchanged
    expect(el.textContent).toContain("NO PROOF YET");
    expect(el.textContent).toContain(
      "This slice has a scaffolded proof/ location that no closeout has populated. Proof-of-work captures (screenshots / videos) and a PROOF.md verdict land here when the closing agent drops them in at slice closeout — no curator required.",
    );
    // the "awaiting proof" micro-label survives ONLY on the absent branch
    expect(screen.getByTestId(`proof-slice-empty-${SID}`).textContent).toContain("awaiting proof");
  });
});
