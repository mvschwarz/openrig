// OPR.0.5.3.5 mini-req 7 — the seat-recap-store subpath surface: the CLI's
// recap-write verb (the outgoing occupant's boundary write) consumes the ONE
// store through this export so supersession + the addressability gate have a
// single home. Same pattern as the other subpath surfaces beside it.
export {
  writeSeatRecap,
  listRecapChain,
  validateRecapContract,
  RECAP_FILENAME,
  RecapWriteError,
  type RecapChainEntry,
  type RecapContractFinding,
} from "./domain/context-packs/seat-recap-store.js";
