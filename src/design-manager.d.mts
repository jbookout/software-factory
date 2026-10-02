export type DesignStage = 'grill' | 'intake' | 'research' | 'define' | 'explore' | 'prototype' | 'test' | 'decide' | 'build-orchestration' | 'implementation-verification' | 'measure' | 'refine';
export type DesignTier = 'lean' | 'standard' | 'high-assurance';
export type DesignGate = 'problem' | 'workflow' | 'concept' | 'interaction' | 'system' | 'build-readiness' | 'implementation-fidelity' | 'operational-evidence' | 'version-closure';
export type EvidenceStrength = 'target-user-observation' | 'representative-user-testing' | 'domain-expert-feedback' | 'owner-task-testing' | 'heuristic-accessibility' | 'competitor-pattern-research' | 'simulated-critique';
export type DesignEntry = 'new-product' | 'feature' | 'workflow-redesign' | 'audit' | 'design-system' | 'platform-derivation' | 'concept-evaluation' | 'post-build-refinement' | 'automation-interaction';
export type ModelMode = 'fast' | 'thorough' | 'specialist' | 'best-available' | 'efficient-eco';
export type DesignRole = 'Design Manager' | 'Research Specialist' | 'Product/UX Strategist' | 'Workflow Architect' | 'Information Architect' | 'Interaction Designer' | 'Prototype Specialist' | 'Visual-System Designer' | 'Accessibility Specialist' | 'Usability/Evaluation Specialist' | 'Adversarial Reviewer' | 'Implementation Translator' | 'Implementation Verifier' | 'Measurement Specialist';
export type WorkStatus = 'active' | 'awaiting-human' | 'blocked' | 'closed';
export type GateStatus = 'pending' | 'pass' | 'fail';

export interface ArtifactRef { ref: string; digest: string } // sha256 of artifact bytes
export interface EvidenceRef extends ArtifactRef { strength: EvidenceStrength }
export interface RoleContract {
  role: DesignRole; inputs: readonly string[]; outputs: readonly string[];
  rubric: string; stop: string;
}
export interface HandoffManifest {
  role: DesignRole; makerId: string; artifact: ArtifactRef;
  evidence: EvidenceRef[]; unresolvedQuestions: string[];
  confidence: number; limits: string[];
}
export interface GateRecord {
  gate: DesignGate; status: GateStatus; artifact: ArtifactRef;
  reviewerId: string; evidence: EvidenceRef[];
}
export interface VersionContract {
  version: number; includedWorkflows: string[]; exclusions: string[];
  knownLimitations: string[]; blockingDefects: string[];
  acceptanceCriteria: string[]; deferredRefinements: string[];
  evidenceWindow: string;
}
export interface DesignProject {
  schema: 'design-project.v1'; projectId: string; sourceRevision: string;
  entry: DesignEntry; tier: DesignTier; stage: DesignStage; status: WorkStatus;
  versionContract: VersionContract; handoffs: HandoffManifest[]; gates: GateRecord[];
}
export const DESIGN_STAGES: readonly DesignStage[];
export const DESIGN_TIERS: readonly DesignTier[];
export const DESIGN_GATES: readonly DesignGate[];
export const EVIDENCE_STRENGTHS: readonly EvidenceStrength[];
export const DESIGN_ENTRIES: readonly DesignEntry[];
export const MODEL_MODES: readonly ModelMode[];
export const DESIGN_ROLES: readonly Readonly<RoleContract>[];
export function nextDesignStage(stage: DesignStage): DesignStage | null;
export function advanceDesignStage(stage: DesignStage, target: DesignStage): DesignStage;
