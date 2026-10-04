import type { ProjectPlatform } from './design-manager.mjs'

export declare const ACCEPTANCE_ENGINE: 'e2e@0.15.1'

export interface ArtifactRef { ref: string; digest: string }
export interface FixtureRef { id: string; revision: number; digest: string }
export interface ContractRef { revision: number; digest: string }
export interface VerifyFeature {
  id: string; title: string; entryPoints: { id: string; route: string; handles: string[] }[];
  subFeatures: string[]; userRoute: string[]; observableEndState: string; storedValues: string[]; gotchas: string[];
}
export interface VerifyFeatureMap {
  index: { schema: 'verify-feature-map.v1'; product: string; features: { id: string; file: string }[] };
  features: VerifyFeature[];
}
export interface VerifyCriterion {
  id: string; expectation: string; blocking: boolean; evidence: 'e2e' | 'manual' | 'judgment';
  platforms: ProjectPlatform[]; featureId: string; entryPoints: string[]; storedValue: boolean;
  defect: { broken: FixtureRef; repaired: FixtureRef; expectedViolation: string };
}
export interface VerifyTrap { id: string; criterionId: string; fixture: FixtureRef }
export interface VerifyCriteriaInput {
  projectId: string; version: number; contract: ContractRef; criteria: VerifyCriterion[]; traps: VerifyTrap[];
}
export type FrozenVerifyCriteria = Readonly<VerifyCriteriaInput & {
  schema: 'design-verify-criteria.v1'; featureMapDigest: string; digest: string }>
export interface VerifyTarget {
  projectId: string; version: number; contract: ContractRef; sourceCommit: string;
  buildDigest: string; buildConfigDigest: string; featureMapDigest: string; fixtures: Record<string, string>;
  platforms: Partial<Record<ProjectPlatform, { targetId: string;
    engines: Partial<Record<VerifyCriterion['evidence'], string>> }>>;
  makers: { ids: string[]; sessions: string[] };
}
export interface DesignCheckRecord {
  schema: 'design-check.v1'; criterionId: string; role: 'candidate' | 'broken' | 'repaired' | 'trap'; trapId?: string;
  binding: { projectId: string; version: number; contractRevision: number; contractDigest: string; sourceCommit: string;
    buildDigest: string; buildConfigDigest: string; platform: ProjectPlatform; engine: string; targetId: string };
  fixture: FixtureRef; actor: string; startingState: string; steps: string[]; expected: string; observed: string;
  method: 'e2e' | 'unit' | 'component' | 'driver' | 'manual' | 'judgment'; oracle: ArtifactRef;
  entryPoint: string; entryPointStatus: 'exercised' | 'skipped' | 'blocked'; outcome: 'passed' | 'failed' | 'blocked';
  finding: string | null; artifacts: ArtifactRef[];
  persistence: { writtenValue: ArtifactRef; independentReadback: ArtifactRef; readbackMethod: string } | null;
}
export interface DesignReviewPayload {
  schema: 'design-review.v1'; reviewerId: string; sessionId: string;
  freshContext: { inheritedSessions: string[]; receivedMakerScores: boolean };
  targetDigest: string; manifestDigest: string; recordsRead: string[]; verdict: 'pass' | 'fail'; aggregateScore: number | null;
}
export interface SignedDesignReview { payload: DesignReviewPayload; signature: string }
export type VerifyGate = 'pass' | 'fail' | 'blocked' | 'pending'
export interface VerificationResult {
  gate: VerifyGate; targetDigest: string | null; reasons: string[];
  criteria: { id: string; blocking: boolean; verdict: VerifyGate; reasons: string[] }[];
  review: { status: 'authenticated' | 'rejected' | 'missing'; reasons: string[] };
}
export type RepairPlan =
  | { action: 'done' } | { action: 'repair'; round: number }
  | { action: 'escalate'; diagnosis: { failedRounds: number; failing: string[] }; question: string }

export function validateFeatureMap(map: VerifyFeatureMap): string[];
export function verifyFeatureMapDigest(map: VerifyFeatureMap): string;
export function freezeVerifyCriteria(input: VerifyCriteriaInput & { featureMap: VerifyFeatureMap }): FrozenVerifyCriteria;
export function verifyTargetDigest(target: VerifyTarget): string;
export function signReviewReceipt(payload: DesignReviewPayload, key: string): SignedDesignReview;
export function planRepair(history: { failedRounds: number; failing: string[] }): RepairPlan;
export function evaluateVerification(input: {
  manifest: FrozenVerifyCriteria; featureMap: VerifyFeatureMap; target: VerifyTarget; records: ArtifactRef[];
  review: SignedDesignReview | null; reviewKey: string;
  readArtifact: (ref: string, options?: { signal?: AbortSignal; maxBytes?: number; timeoutMs?: number }) => Promise<Buffer | null> | Buffer | null;
  limits?: { timeoutMs?: number; maxBytes?: number };
}): Promise<VerificationResult>;

export interface ProductProofIdentity {
  repo: string; sourceCommit: string; buildDigest: string; buildConfigDigest: string; fixtureDigest: string;
  runtime: { e2e: string; web: string; playwright: string; node: string; browser: string };
}
export interface ProductProofPacket {
  schema: 'browser-product-proof.v1'; binding: ProductProofIdentity & { runId: string; attempt: number };
  build: ArtifactRef; buildArchive: ArtifactRef; nativeReport: ArtifactRef; coverage: ArtifactRef;
  persistence: { id: string; written: ArtifactRef; readback: ArtifactRef }[];
  recordings: { id: string; operation: 'save-reload'; video: ArtifactRef; trace: ArtifactRef; checkpoint: ArtifactRef }[];
  links: { run: string; artifacts: string };
  metrics: { firstReviewUiFindings: number | null; reproductionMinutes: number | null };
}
export declare const PRODUCT_PROOF_RUNTIME: Readonly<{ e2e: '0.16.0'; web: '0.11.2'; playwright: '1.63.0'; browser: 'chromium' }>;
export declare function evaluateProductProofPacket(input: {
  packet: ProductProofPacket;
  expected: ProductProofIdentity & { runId: string; attempt: number; requiredNativeTests: string[]; requiredCoverage: string[]; requiredPersistence: string[];
    requiredRecordings: { id: string; operation: 'save-reload' }[] };
  readArtifact: (ref: string, options?: { signal: AbortSignal; maxBytes: number; timeoutMs: number }) => Promise<Buffer | null>;
  inspectRecording: (input: { video: Buffer; trace: Buffer; checkpoint: Buffer; operation: string }) => Promise<{ decoded: boolean; operationPresent: boolean }>;
  limits?: { timeoutMs?: number; maxBytes?: number };
}): Promise<{ gate: 'pass' | 'fail'; reasons: string[]; sourceCommit: string | null }>;

export declare function productProofReviewMetrics(input: {repo:string; sourceCommit:string; reviewedSha:string; commentUrl:string; firstReviewUiFindings:number; reproductionMinutes:number}): {schema:'browser-proof-review-metrics.v1'; repo:string; sourceCommit:string; commentUrl:string; firstReviewUiFindings:number; reproductionMinutes:number};
