import type { Migration } from "../migrate.js";

/**
 * Who an MCP adapter's validated caller was, beside the era-provenance stamp on the same four identity-carrying stores as
 * migration 067. A row records it only with `principal:v1`: a direct request whose seat came from the transport header
 * and whose adapter checked a grant (a token-file grant or an external grant service's grant) and supplied this
 * principal. It's attribution, not daemon authentication. JSON of the principal's source, id and, for a grant-service
 * grant, its grant id and version; never a credential or a stored verifier. Additive and nullable: absent on every
 * earlier row (no backfill) and on every row a request without that metadata writes. The transitions archive gets it
 * too, as migration 082 gave it the provenance stamp, so retention keeps a row's principal with the row.
 */
export const identityPrincipalSchema: Migration = {
  name: "140_identity_principal.sql",
  sql: `
    ALTER TABLE queue_transitions ADD COLUMN identity_principal TEXT;
    ALTER TABLE queue_transitions_archive ADD COLUMN identity_principal TEXT;
    ALTER TABLE inbox_entries ADD COLUMN identity_principal TEXT;
    ALTER TABLE outbox_entries ADD COLUMN identity_principal TEXT;
    ALTER TABLE stream_items ADD COLUMN identity_principal TEXT;
  `,
};
