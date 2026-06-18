import type { Migration } from "../migrate.js";

export const resumeProvenanceSchema: Migration = {
  name: "043_resume_provenance.sql",
  sql: `ALTER TABLE sessions ADD COLUMN resume_provenance TEXT;`,
};
