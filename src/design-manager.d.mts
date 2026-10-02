export type DesignStage = 'grill' | 'intake' | 'research' | 'define' | 'explore' | 'prototype' | 'test' | 'decide' | 'build-orchestration' | 'implementation-verification' | 'measure' | 'refine';
export type DesignTier = 'lean' | 'standard' | 'high-assurance';
export type DesignGate = 'problem' | 'workflow' | 'concept' | 'interaction' | 'system' | 'build-readiness' | 'implementation-fidelity' | 'operational-evidence' | 'version-closure';
export type EvidenceStrength = 'target-user-observation' | 'representative-user-testing' | 'domain-expert-feedback' | 'owner-task-testing' | 'heuristic-accessibility' | 'competitor-pattern-research' | 'simulated-critique';
export type DesignEntry = 'new-product' | 'feature' | 'workflow-redesign' | 'audit' | 'design-system' | 'platform-derivation' | 'concept-evaluation' | 'post-build-refinement' | 'automation-interaction';
export type ModelMode = 'fast' | 'thorough' | 'specialist' | 'best-available' | 'efficient-eco';
export type DesignRole = 'Design Manager' | 'Research Specialist' | 'Product/UX Strategist' | 'Workflow Architect' | 'Information Architect' | 'Interaction Designer' | 'Prototype Specialist' | 'Visual-System Designer' | 'Accessibility Specialist' | 'Usability/Evaluation Specialist' | 'Adversarial Reviewer' | 'Implementation Translator' | 'Implementation Verifier' | 'Measurement Specialist';
export type WorkStatus = 'active' | 'awaiting-human' | 'blocked' | 'closed';
export type GateStatus = 'pending' | 'pass' | 'fail' | 'blocked';
export type DesignStation = 'research' | 'define' | 'design' | 'prove' | 'ship';
export type ProjectPlatform = 'web' | 'ios' | 'android' | 'desktop';
export type EvaluationOutcome = 'passed' | 'failed' | 'blocked';
export type EntryPointStatus = 'exercised' | 'skipped' | 'blocked';
export type VerificationMethod = 'verify-skill' | 'e2e';

export interface ArtifactRef { ref: string; digest: string } // sha256 of artifact bytes
export interface PersistenceProof {
  writtenValue: ArtifactRef; independentReadback: ArtifactRef; readbackMethod: string;
}
export interface VerificationProof {
  sourceRevision: string; platform: ProjectPlatform; method: VerificationMethod;
  entryPoint: string; entryPointStatus: EntryPointStatus; outcome: EvaluationOutcome;
  actionAndResult: ArtifactRef; persistence: PersistenceProof | null;
}
// Prove must exercise the real user path and read stored values a second way.
// A skipped or blocked entry point never counts as verified.
export interface EvidenceRef extends ArtifactRef {
  strength: EvidenceStrength; verification?: VerificationProof;
}
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
  platforms: ProjectPlatform[]; entry: DesignEntry; tier: DesignTier; stage: DesignStage; status: WorkStatus;
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

export const DESIGN_STATIONS: readonly DesignStation[];
export const PROJECT_PLATFORMS: readonly ProjectPlatform[];
export const MOBILE_CAPABILITY_REQUIRED: string;
export interface RepositoryPlatformSignals {
  dependencies: readonly string[]; paths: readonly string[];
  appJsonPlatforms?: readonly ProjectPlatform[];
}
export interface PlatformInspection {
  detected: ProjectPlatform[]; missing: ProjectPlatform[]; mismatch: boolean;
}
export interface GateRequirement { status: 'pending' | 'pass' | 'fail'; message: string }
export function stationForDesignStage(stage: DesignStage): DesignStation;
export function stationForDesignGate(gate: DesignGate): DesignStation;
export function inspectProjectPlatforms(platforms: readonly ProjectPlatform[], signals: RepositoryPlatformSignals): PlatformInspection;
export function isVerifiedUserPath(evidence: EvidenceRef, sourceRevision: string): boolean;
export function evaluateMobileVerification(project: DesignProject, availableCapabilities: readonly string[], evidence?: readonly EvidenceRef[]): GateRequirement;
