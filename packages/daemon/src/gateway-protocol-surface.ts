// M1 A5 — narrow public surface for the gateway<->connector wire codec, so the cli-side Slack
// CONNECTOR (which listens on the socket the gateway dials) can decode/encode framed messages
// against the ONE canonical protocol definition. Lane rule: exports map + dist + cli tsconfig
// paths, all three (a cli consumer of a daemon subpath). Re-export only — no logic here.
export * from "./domain/gateway/protocol.js";
