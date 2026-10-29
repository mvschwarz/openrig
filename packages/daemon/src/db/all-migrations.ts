import { nodeAccountHomeSchema } from "./migrations/141_node_account_home.js";
import { escalationTargetRefsSchema } from "./migrations/126_escalation_target_refs.js";
import { claudeTokenReadingsSchema } from "./migrations/134_claude_token_readings.js";
// The canonical ordered migration list. SINGLE SOURCE: the daemon boot path
// (startup.ts) and any test/tool that needs a schema-faithful DB both migrate from THIS array,
// so a reader DB is never seeded from a stale hand-copied subset (the perf-fixture-migration-parity
// trap). Append new migrations to the END, in order.

import { nodeClaudePermissionsSchema } from "./migrations/139_node_claude_permissions.js";
import { identityPrincipalSchema } from "./migrations/140_identity_principal.js";
import { sessionAgentRunnerSchema } from "./migrations/141_session_agent_runner.js";
import { nodeClaudeMcpSchema } from "./migrations/142_node_claude_mcp.js";
import { nodeCodexPermissionsSchema } from "./migrations/137_node_codex_permissions.js";
import { coreSchema } from "./migrations/001_core_schema.js";
import { terminalPolicySchema } from "./migrations/128_terminal_policy.js";
import { streamDispositionsSchema } from "./migrations/129_stream_dispositions.js";
import { streamSubscriptionsSchema } from "./migrations/130_stream_subscriptions.js";
import { streamRetentionFloorSchema } from "./migrations/131_stream_retention_floor.js";
import { seatRuntimeSwitchesSchema } from "./migrations/132_seat_runtime_switches.js";
import { streamReaderActionsSchema } from "./migrations/133_stream_reader_actions.js";
import { seatIdentityProcessEvidenceSchema } from "./migrations/135_seat_identity_process_evidence.js";
import { nodeClaudeTokenRefSchema } from "./migrations/138_node_claude_token_ref.js";
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
import { seatEnvSchema } from "./migrations/111_seat_env.js";
import { nodePermissionPolicySchema } from "./migrations/055_node_permission_policy.js";
import { rigPermissionPolicySchema } from "./migrations/056_rig_permission_policy.js";
import { nodePolicyProvenanceSchema } from "./migrations/057_node_policy_provenance.js";
import { rigPolicyProvenanceSchema } from "./migrations/058_rig_policy_provenance.js";
import { selfHostIdentitySchema } from "./migrations/059_self_host_identity.js";
import { occupantTenuresSchema } from "./migrations/060_occupant_tenures.js";
import { daemonLifecycleSchema } from "./migrations/061_daemon_lifecycle.js";
import { usageSamplesSchema } from "./migrations/062_usage_samples.js";
import { occupantGenerationStampsSchema } from "./migrations/063_occupant_generation_stamps.js";
import { projectionManifestSchema } from "./migrations/064_projection_manifest.js";
import { identityProvenanceSchema } from "./migrations/065_identity_provenance.js";
import { watchdogTargetGenerationSchema } from "./migrations/066_watchdog_target_generation.js";
import { i3IdentityProvenanceSchema } from "./migrations/067_i3_identity_provenance.js";
import { enforcerDecisionsSchema } from "./migrations/068_enforcer_decisions.js";
import { appliedLaunchObservationsSchema } from "./migrations/069_applied_launch_observations.js";
import { appliedLaunchObservationInvalidationsSchema } from "./migrations/070_applied_launch_observation_invalidations.js";
import { dropEnforcerDecisionsSchema } from "./migrations/071_drop_enforcer_decisions.js";
import { threadSeatMapSchema } from "./migrations/072_thread_seat_map.js";
import { queueTransitionWakesSchema } from "./migrations/073_queue_transition_wakes.js";
import { contextUsageWatchdogSchema } from "./migrations/074_context_usage_watchdog.js";
import { contextUsageWatchdogGenerationSchema } from "./migrations/075_context_usage_watchdog_generation.js";
import { ownerNotificationLevelsSchema } from "./migrations/076_owner_notification_levels.js";
import { nodeSessionSourceSchema } from "./migrations/077_node_session_source.js";
import { idleGateFiredConditionSchema } from "./migrations/078_idle_gate_fired_condition.js";
import { workflowLifecycleParallelSchema } from "./migrations/079_workflow_lifecycle_parallel.js";
import { humanNotificationIntentSchema } from "./migrations/081_human_notification_intent.js";
import { archiveIdentityProvenanceSchema } from "./migrations/082_archive_identity_provenance.js";
import { reviewReadIndexesSchema } from "./migrations/083_review_read_indexes.js";
import { inventoryEventIndexesSchema } from "./migrations/084_inventory_event_indexes.js";
import { rigClaudeManagedBlockFileSchema } from "./migrations/085_rig_claude_managed_block_file.js";
import { classificationFieldsAndAttemptsSchema } from "./migrations/086_classification_fields_and_attempts.js";
import { scopedOperatingPostureSchema } from "./migrations/080_scoped_operating_posture.js";
import { seatDeliveryGuardSchema } from "./migrations/087_seat_delivery_guard.js";
import { nodePermissionSelectionsSchema } from "./migrations/088_node_permission_selections.js";
import { classificationIdentityProvenanceSchema } from "./migrations/089_classification_identity_provenance.js";
import { humanReplyToSchema } from "./migrations/090_human_reply_to.js";
import { humanQuestionsSchema } from "./migrations/091_human_questions.js";
import { nodeEffortSchema } from "./migrations/092_node_effort.js";
import { nodeEffortChoiceSchema } from "./migrations/104_node_effort_choice.js";
import { usageSamplesLatestIndexesSchema } from "./migrations/094_usage_samples_latest_indexes.js";
import type { Migration } from "./migrate.js";

import { rigNonInterruptiveSchema } from "./migrations/095_rig_non_interruptive.js";
import { rigInstallRootSchema } from "./migrations/096_rig_install_root.js";
import { threadPartMapSchema } from "./migrations/097_thread_part_map.js";
import { queueTransitionsQitemIdOrderSchema } from "./migrations/098_queue_transitions_qitem_id_order.js";
import { queueItemsRecoveryTagsSchema } from "./migrations/099_queue_items_recovery_tags.js";
import { typingGuardModesSchema } from "./migrations/100_typing_guard_modes.js";
import { resumeRotationSchema } from "./migrations/101_claude_resume_rotation.js";
import { sessionStopIntentSchema } from "./migrations/103_session_stop_intent.js";
import { usageSamplesClientCostSchema } from "./migrations/105_usage_samples_client_cost.js";
import { piUsageEntriesSchema } from "./migrations/107_pi_usage_entries.js";
import { piUsageChargesSchema } from "./migrations/108_pi_usage_charges.js";
import { modePostureCoexistSchema } from "./migrations/109_mode_posture_coexist.js";
import { workflowInstanceScopeSchema } from "./migrations/110_workflow_instance_scope.js";
import { queueTransitionsTsQitemSchema } from "./migrations/112_queue_transitions_ts_qitem.js";
import { appliedLaunchDaemonOptOutSchema } from "./migrations/113_applied_launch_daemon_opt_out.js";
import { sessionAgentAppSchema as sessionCommunityHarnessSchema } from "./migrations/114_session_agent_app.js";
import { threadSeatMapChannelKeySchema } from "./migrations/115_thread_seat_map_channel_key.js";
import { nodeLaunchRecipeSchema } from "./migrations/136_node_launch_recipe.js";
import { queueItemWakeInputBoxSchema } from "./migrations/116_queue_item_wake_input_box.js";
import { providerAccountReadingsSchema } from "./migrations/117_provider_account_readings.js";
import { humanQuietWindowsSchema } from "./migrations/118_human_quiet_windows.js";
import { seatIdentityPanePidSchema } from "./migrations/119_seat_identity_pane_pid.js";
import { rigStartupLayersSchema } from "./migrations/121_rig_startup_layers.js";
import { humanOperatingModesSchema } from "./migrations/122_human_operating_modes.js";
import { queueDelegatedDecisionSchema } from "./migrations/123_queue_delegated_decision.js";
import { contextUsageWatchdogUnitsSchema } from "./migrations/124_context_usage_watchdog_units.js";
import { nodeAdvisorSchema } from "./migrations/125_node_advisor.js";
import { operationCorrelationSchema } from "./migrations/127_operation_correlation.js";

/** Ordered migrations; numbers may be reserved by independent changes. */

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
  daemonLifecycleSchema,
  usageSamplesSchema,
  occupantGenerationStampsSchema,
  projectionManifestSchema,
  identityProvenanceSchema,
  watchdogTargetGenerationSchema,
  i3IdentityProvenanceSchema,
  enforcerDecisionsSchema,
  appliedLaunchObservationsSchema,
  appliedLaunchObservationInvalidationsSchema,
  dropEnforcerDecisionsSchema,
  threadSeatMapSchema,
  queueTransitionWakesSchema,
  contextUsageWatchdogSchema,
  contextUsageWatchdogGenerationSchema,
  ownerNotificationLevelsSchema,
  nodeSessionSourceSchema,
  idleGateFiredConditionSchema,
  workflowLifecycleParallelSchema,
  scopedOperatingPostureSchema,
  humanNotificationIntentSchema,
  archiveIdentityProvenanceSchema,
  reviewReadIndexesSchema,
  inventoryEventIndexesSchema,
  rigClaudeManagedBlockFileSchema,
  classificationFieldsAndAttemptsSchema,
  seatDeliveryGuardSchema,
  nodePermissionSelectionsSchema,
  classificationIdentityProvenanceSchema,
  humanReplyToSchema,
  humanQuestionsSchema,
  nodeEffortSchema,
  usageSamplesLatestIndexesSchema,
  rigNonInterruptiveSchema,
  rigInstallRootSchema,
  threadPartMapSchema,
  queueTransitionsQitemIdOrderSchema,
  queueItemsRecoveryTagsSchema,
  typingGuardModesSchema,
  resumeRotationSchema,
  sessionStopIntentSchema,
  nodeEffortChoiceSchema,
  usageSamplesClientCostSchema,
  piUsageEntriesSchema,
  piUsageChargesSchema,
  modePostureCoexistSchema,
  workflowInstanceScopeSchema,
  seatEnvSchema,
  queueTransitionsTsQitemSchema,
  appliedLaunchDaemonOptOutSchema,
  sessionCommunityHarnessSchema,
  threadSeatMapChannelKeySchema,
  queueItemWakeInputBoxSchema,
  providerAccountReadingsSchema,
  humanQuietWindowsSchema,
  seatIdentityPanePidSchema,
  rigStartupLayersSchema,
  humanOperatingModesSchema,
  queueDelegatedDecisionSchema,
  contextUsageWatchdogUnitsSchema,
  nodeAdvisorSchema,
  escalationTargetRefsSchema,
  operationCorrelationSchema,
  terminalPolicySchema,
  streamDispositionsSchema,
  streamSubscriptionsSchema,
  streamRetentionFloorSchema,
  seatRuntimeSwitchesSchema,
  streamReaderActionsSchema,
  claudeTokenReadingsSchema,
  seatIdentityProcessEvidenceSchema,
  nodeLaunchRecipeSchema,
  nodeClaudeTokenRefSchema,
  nodeClaudePermissionsSchema,
  nodeCodexPermissionsSchema,
  identityPrincipalSchema,
  sessionAgentRunnerSchema,
  nodeAccountHomeSchema,
  nodeClaudeMcpSchema,
];
