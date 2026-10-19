export { loadConfig, saveConfig, configPathFor, validateConfig, DEFAULT_CONFIG, parseMatrixBinding, type MatrixConnectorConfig } from "./domain/gateway/matrix/config.js";
export { resolveAccessToken, saveAccessToken } from "./domain/gateway/matrix/secrets.js";
export { MatrixClient, MatrixApiError, MatrixTokenError, type FetchImpl } from "./domain/gateway/matrix/matrix-api.js";
export { MATRIX_MANIFEST } from "./domain/gateway/matrix/manifest.js";
export { runChannelOperation, channelStateDigest } from "./domain/gateway/channel-operations.js";
