// Vellum Lab — design experiment surface at /lab/vellum-lab.
//
// Post-refactor (2026-05-14): thin composition over the shared vellum
// primitives in ../dashboard/vellum. The lab and the production
// /dashboard surface render the SAME components — single source of
// truth for the visual system.
//
// The optional override props (backLayerOverride / vellumSheetOverride)
// stay so the /lab/vellum-bg/* background experiment routes keep
// working without forking the whole lab page.

import type { ReactNode } from "react";
import {
  BackLayerContent,
  BackVellumSheet,
  MidLayerContent,
  TopLayerContent,
  DestinationsLayer,
} from "../dashboard/vellum/index.js";

interface VellumLabProps {
  backLayerOverride?: ReactNode;
  vellumSheetOverride?: ReactNode;
}

export function VellumLab({
  backLayerOverride,
  vellumSheetOverride,
}: VellumLabProps = {}) {
  return (
    <div
      data-testid="vellum-lab"
      className="relative min-h-screen overflow-hidden"
    >
      {/* LAYER 0 — back content (bold black, full bleed) */}
      {backLayerOverride ?? <BackLayerContent />}

      {/* LAYER 1 — back vellum sheet (heavy blur on most of canvas) */}
      {vellumSheetOverride ?? <BackVellumSheet />}

      {/* LAYER 2 — mid content (smaller; peeks through back sheet) */}
      <MidLayerContent />

      {/* LAYER 4 — top crisp fine-line elements (the printed top of stack) */}
      <TopLayerContent />

      {/* LAYER 5 — DESTINATIONS (clickable launcher elements). */}
      <DestinationsLayer />
    </div>
  );
}
