// Loaded into the conformance check's own process only (node --require), to stand in for a busy machine: every timer of
// 800 ms or more fires 1.5 s late, while short polls keep their pace. A check that reads a fixed settle against a fake
// agent's delay then reads after that delay has passed, as it can when hosted CI runs many checks at once.
const original = setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => original(fn, typeof ms === "number" && ms >= 800 ? ms + 1500 : ms, ...rest);
