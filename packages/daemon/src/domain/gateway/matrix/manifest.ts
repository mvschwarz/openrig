import { MATRIX_CAPABILITIES } from "./capabilities.js";
// Matrix bot users require no application manifest or public callback endpoint.
export const MATRIX_MANIFEST = { kind: "matrix", authentication: "bot-access-token", capabilities: MATRIX_CAPABILITIES };
