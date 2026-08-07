// The canonical ordered migration list (001 → 059). SINGLE SOURCE: the daemon boot path
// (startup.ts) and any test/tool that needs a schema-faithful DB both migrate from THIS array,
// so a reader DB is never seeded from a stale hand-copied subset (the perf-fixture-migration-parity
// trap). Append new migrations to the END, in order.

import { coreSchema } from "./migrations/001_core_schema.js";
import { bindingsSessionsSchema } from "./migrations/002_bindings_sessions.js";
import { eventsSchema } from "./migrations/003_events.js";
import { snapshotsSchema } from "./migrations/004_snapshots.js";
import { checkpointsSchema } from "./migrations/005_checkpoints.js";
import { resumeMetadataSchema } from "./migrations/006_resume_metadata.js";
import { nodeSpecFieldsSchema } from "./migrations/007_node_spec_fields.js";
import { packagesSchema } from "./migrations/008_packages.js";
import { installJournalSchema } from "./migrations/009_install_journal.js";
import { journalSeqSchema } from "./migrations/010_journal_seq.js";
import { bootstrapSchema } from "./migrations/011_bootstrap.js";
import { discoverySchema } from "./migrations/012_discovery.js";
import { discoveryFkFix } from "./migrations/013_discovery_fk_fix.js";
import { agentspecRebootSchema } from "./migrations/014_agentspec_reboot.js";
import { startupContextSchema } from "./migrations/015_startup_context.js";
import { chatMessagesSchema } from "./migrations/016_chat_messages.js";
import { podNamespaceSchema } from "./migrations/017_pod_namespace.js";
import { contextUsageSchema } from "./migrations/018_context_usage.js";
import { externalCliAttachmentSchema } from "./migrations/019_external_cli_attachment.js";
import { rigServicesSchema } from "./migrations/020_rig_services.js";
import { seatHandoverObservabilitySchema } from "./migrations/021_seat_handover_observability.js";
import { nodeCodexConfigProfileSchema } from "./migrations/022_node_codex_config_profile.js";
import { streamItemsSchema } from "./migrations/023_stream_items.js";
import { queueItemsSchema } from "./migrations/024_queue_items.js";
import { queueTransitionsSchema } from "./migrations/025_queue_transitions.js";
import { inboxEntriesSchema } from "./migrations/026_inbox_entries.js";
import { outboxEntriesSchema } from "./migrations/027_outbox_entries.js";
import { projectClassificationsSchema } from "./migrations/028_project_classifications.js";
import { classifierLeasesSchema } from "./migrations/029_classifier_leases.js";
import { viewsCustomSchema } from "./migrations/030_views_custom.js";
import { watchdogJobsSchema } from "./migrations/031_watchdog_jobs.js";
import { watchdogHistorySchema } from "./migrations/032_watchdog_history.js";
import { workflowSpecsSchema } from "./migrations/033_workflow_specs.js";
import { workflowInstancesSchema } from "./migrations/034_workflow_instances.js";
import { workflowStepTrailsSchema } from "./migrations/035_workflow_step_trails.js";
import { watchdogPolicyEnumExtensionSchema } from "./migrations/036_watchdog_policy_enum_extension.js";
import { missionControlActionsSchema } from "./migrations/037_mission_control_actions.js";
import { workspacePrimitiveSchema } from "./migrations/038_workspace_primitive.js";
import { queueTargetRepoSchema } from "./migrations/039_queue_target_repo.js";
import { workflowSpecsDiagnosticSchema } from "./migrations/040_workflow_specs_diagnostic.js";
import { rigPolicySchema } from "./migrations/041_rig_policy.js";
import { rigArchiveSchema } from "./migrations/042_rig_archive.js";
import { resumeProvenanceSchema } from "./migrations/043_resume_provenance.js";
import { queueItemSummarySchema } from "./migrations/044_queue_item_summary.js";
import { resumeVerificationSchema } from "./migrations/045_resume_verification.js";
import { seatIdentityVerdictsSchema } from "./migrations/046_seat_identity_verdicts.js";
import { eventsNodeTypeIndexSchema } from "./migrations/047_events_node_type_index.js";
import { queueItemEvidenceRefSchema } from "./migrations/048_queue_item_evidence_ref.js";
import { workflowInstanceVersionSchema } from "./migrations/049_workflow_instance_version.js";
import { workflowSpecJsonSchema } from "./migrations/050_workflow_spec_json.js";
import { workflowResumeSchema } from "./migrations/051_workflow_resume.js";
import { workflowInstanceBoundRigSchema } from "./migrations/052_workflow_instance_bound_rig.js";
import { sessionsNodeIdIndexSchema } from "./migrations/053_sessions_node_id_index.js";
import { queueTransitionsArchiveSchema } from "./migrations/054_queue_transitions_archive.js";
import { nodePermissionPolicySchema } from "./migrations/055_node_permission_policy.js";
import { rigPermissionPolicySchema } from "./migrations/056_rig_permission_policy.js";
import { nodePolicyProvenanceSchema } from "./migrations/057_node_policy_provenance.js";
import { rigPolicyProvenanceSchema } from "./migrations/058_rig_policy_provenance.js";
import { selfHostIdentitySchema } from "./migrations/059_self_host_identity.js";
import { occupantTenuresSchema } from "./migrations/060_occupant_tenures.js";
import { usageSamplesSchema } from "./migrations/062_usage_samples.js";
import { occupantGenerationStampsSchema } from "./migrations/063_occupant_generation_stamps.js";
import type { Migration } from "./migrate.js";

/** Ordered 001→063 (061 P7 in flight). Mirrors the daemon boot migration order. */
export const ALL_MIGRATIONS: Migration[] = [
  coreSchema,
  bindingsSessionsSchema,
  eventsSchema,
  snapshotsSchema,
  checkpointsSchema,
  resumeMetadataSchema,
  nodeSpecFieldsSchema,
  packagesSchema,
  installJournalSchema,
  journalSeqSchema,
  bootstrapSchema,
  discoverySchema,
  discoveryFkFix,
  agentspecRebootSchema,
  startupContextSchema,
  chatMessagesSchema,
  podNamespaceSchema,
  contextUsageSchema,
  externalCliAttachmentSchema,
  rigServicesSchema,
  seatHandoverObservabilitySchema,
  nodeCodexConfigProfileSchema,
  streamItemsSchema,
  queueItemsSchema,
  queueTransitionsSchema,
  inboxEntriesSchema,
  outboxEntriesSchema,
  projectClassificationsSchema,
  classifierLeasesSchema,
  viewsCustomSchema,
  watchdogJobsSchema,
  watchdogHistorySchema,
  workflowSpecsSchema,
  workflowInstancesSchema,
  workflowStepTrailsSchema,
  watchdogPolicyEnumExtensionSchema,
  missionControlActionsSchema,
  workspacePrimitiveSchema,
  queueTargetRepoSchema,
  workflowSpecsDiagnosticSchema,
  rigPolicySchema,
  rigArchiveSchema,
  resumeProvenanceSchema,
  queueItemSummarySchema,
  resumeVerificationSchema,
  seatIdentityVerdictsSchema,
  eventsNodeTypeIndexSchema,
  queueItemEvidenceRefSchema,
  workflowInstanceVersionSchema,
  workflowSpecJsonSchema,
  workflowResumeSchema,
  workflowInstanceBoundRigSchema,
  sessionsNodeIdIndexSchema,
  queueTransitionsArchiveSchema,
  nodePermissionPolicySchema,
  rigPermissionPolicySchema,
  nodePolicyProvenanceSchema,
  rigPolicyProvenanceSchema,
  selfHostIdentitySchema,
  occupantTenuresSchema,
  usageSamplesSchema,
  occupantGenerationStampsSchema,
];
