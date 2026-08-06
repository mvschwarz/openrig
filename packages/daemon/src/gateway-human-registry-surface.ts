// The NARROW `@openrig/daemon/gateway-human-registry` public surface (packaging ruling A,
// same rail as ./crash-cart): the human-fragment schema + registry projection + the
// verb-add writer. The registry is home-state (fragments under getOpenRigHome()), so the
// daemon is its canonical home; the CLI `rig gateway human add` verb lazy-imports THIS
// surface (dep rail 2) instead of carrying a second copy — ONE source, no twin-parity pin.
export * from "./domain/gateway/human-registry.js";
