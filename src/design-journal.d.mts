import type { DesignInterviewView, InterviewAnswer, ScopeProposal, LayerAssessment,
  GateRecord, HandoffManifest, ProjectPlatform } from './design-manager.mjs';
import type { DesignCheckRecord } from './design-verify.mjs';

/** Trusted host-selected authorization scope; callers cannot override it in a command. */
export interface JournalScope { userId: string; projectId: string; version: number }
export interface JournalArtifact { ref: string; digest: string } // bare hex sha256; ref is sha256:<hex>
export type ReferenceLabel = 'still' | 'recording' | 'live' | 'inspected-source' | 'vendor-claim';
export interface DesignReference {
  schema: 'design-reference.v1'; id: string;
  source: { url: string; author: string; revision: string | null; sourceDate: string;
    inspectedAt: string; availability: 'available' | 'blocked' | 'unavailable' | 'unverified' };
  label: ReferenceLabel; origin: 'captured' | 'generated' | 'reconstructed'; platform: ProjectPlatform;
  viewport: { width: number; height: number }; state: string; artifacts: JournalArtifact[];
  observedProperty: string; inference: string;
  claim: 'appearance' | 'transition' | 'behavior' | 'implementation' | 'vendor-claim' | 'unverified';
  userDecision: string; borrowedProperty: string; adaptation: string; mismatch: string; rejectionTest: string;
  reviewerOutcome: 'pending' | 'accepted' | 'rejected' | 'blocked'; limits: string[];
  reuse: { status: 'link-only' | 'permission-unverified' | 'copied'; license: string | null; permission: string | null };
  experiment: { hypothesis: string; failedProperty: string | null; replacement: string | null };
}
export interface DesignDecision {
  schema: 'design-decision.v1'; id: string; sourceRevision: string; decision: string;
  rationale: string; alternatives: string[]; limits: string[]; artifacts: JournalArtifact[];
}
export type JournalRecord = { kind: 'reference'; record: DesignReference }
  | { kind: 'decision'; record: DesignDecision } | { kind: 'gate'; record: GateRecord }
  | { kind: 'worker-receipt'; record: HandoffManifest } | { kind: 'evidence'; record: DesignCheckRecord };
export type ArtifactOrigin = 'captured' | 'generated' | 'reconstructed' | 'unspecified';
export type JournalMutation = { command: 'archive'; bytes: string; origin: ArtifactOrigin } // base64, 1 MiB limit
  | ({ command: 'append' } & JournalRecord)
  | { command: 'start-interview'; sourceRevision: string }
  | { command: 'answer-interview'; response: { questionId: string; answer: InterviewAnswer } }
  | { command: 'propose-scope'; proposal: ScopeProposal }
  | { command: 'reassess-layer'; assessment: LayerAssessment };
export interface MutationBinding { expectedRevision: number; idempotencyKey: string }
export interface JournalReceipt { revision: number; artifact?: JournalArtifact; recordId?: string; view?: DesignInterviewView }
export interface JournalState {
  revision: number; view: DesignInterviewView | null; authority: 'reported-only';
  records: (JournalRecord & { revision: number; digest: string })[];
  events: { revision: number; request: (Exclude<JournalMutation, { command: 'archive' }>
    | { command: 'archive'; artifactDigest: string; origin: ArtifactOrigin }) & MutationBinding; result: JournalReceipt }[];
  hostQualification: { status: 'blocked'; reason: string };
}
export interface JournalBackup { schema: 'design-journal-backup.v1'; databaseDigest: string; artifacts: number }
export interface DesignJournal {
  execute(request: { command: 'read' }): Promise<JournalState>;
  execute(request: { command: 'backup'; destination: string }): Promise<JournalBackup>;
  execute(request: JournalMutation & MutationBinding): Promise<JournalReceipt>;
  readArtifact(ref: string): Promise<Buffer>;
}
/** Private POSIX state, outside Git. Python 3.11+ with SQLite deserialization is required. */
export function openDesignJournal(options: JournalScope & { root?: string }): Promise<DesignJournal>;
/** Administrative restore into a new private directory; no overwrite or cross-scope import. */
export function restoreDesignJournal(options: JournalScope & { root: string; backupRoot: string }): Promise<DesignJournal>;
