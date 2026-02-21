/**
 * InfiniClaw configuration layer.
 * Re-exports all upstream NanoClaw config.
 *
 * InfiniClaw-specific vars (ASSISTANT_ROLE, IGNORE_*, Matrix, Local CLI, etc.)
 * live in ../config.ts alongside upstream vars. The additions are additive and
 * easy to reconcile when rebasing on new upstream.
 */
export * from '../config.js';
