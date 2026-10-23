import type { Migration } from "../migrate.js";

export const terminalPolicySchema: Migration = {
  name: "128_terminal_policy.sql",
  sql: `
    CREATE TABLE rig_terminal_policy_defaults (
      rig_id TEXT PRIMARY KEY REFERENCES rigs(id) ON DELETE CASCADE,
      config_json TEXT NOT NULL,
      actor TEXT,
      instruction TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE seat_terminal_policies (
      node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
      config_json TEXT NOT NULL,
      source TEXT NOT NULL,
      actor TEXT,
      instruction TEXT NOT NULL,
      changed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Upgrading never tightens an existing seat's policy.
    INSERT INTO seat_terminal_policies(node_id,config_json,source,instruction)
      SELECT id, '{"preset":"full-control","helpers":[],"exceptions":{}}',
        'upgrade', 'Existing behaviour retained on upgrade.' FROM nodes;
    -- Copy at creation, for every node writer. A later rig-default edit cannot change an existing seat.
    CREATE TRIGGER node_terminal_policy AFTER INSERT ON nodes BEGIN
      INSERT INTO seat_terminal_policies(node_id,config_json,source,actor,instruction)
      VALUES (NEW.id,
        COALESCE((SELECT config_json FROM rig_terminal_policy_defaults WHERE rig_id=NEW.rig_id),
          '{"preset":"full-control","helpers":[],"exceptions":{}}'),
        CASE WHEN EXISTS(SELECT 1 FROM rig_terminal_policy_defaults WHERE rig_id=NEW.rig_id)
          THEN 'rig_default' ELSE 'current_behaviour' END,
        (SELECT actor FROM rig_terminal_policy_defaults WHERE rig_id=NEW.rig_id),
        COALESCE((SELECT instruction FROM rig_terminal_policy_defaults WHERE rig_id=NEW.rig_id),
          'Current behaviour; no terminal policy was selected.'));
    END;
  `,
};
