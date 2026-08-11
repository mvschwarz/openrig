// Build B — narrow public surface for spec-vs-live topology conformance, so the cli-side `rig
// doctor` and the daemon-side bundle-export path answer with the SAME delta. Two surfaces
// disagreeing about the size of a rig is the defect one layer up from the one this reports.
// Lane rule: exports map + dist + cli tsconfig paths, all three. Re-export only — no logic here.
export * from "./domain/spec-live-conformance.js";
