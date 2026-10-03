export interface QualificationCheck { status: 'passed' | 'blocked' | 'unsupported' | 'unverified'; reason: string }
export interface SettingsBinding {
  userId: string; version: number; settingsDigest: string; workerId: string; station: string; mode: string;
}
export interface CloudQualificationOptions {
  stateFile: string; sourceRevision: string; model: string; effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  cwd?: string; codexCommand?: string[]; timeoutMs?: number; settingsBinding?: SettingsBinding;
  /** Caller must select and inspect this factory-only environment. CLI cannot attest its repository. */
  environment?: { id: string; repository: 'jbookout/software-factory'; branch: string; factoryOnly: true } | null;
}
export interface CloudQualificationReceipt {
  schema: 'codex-cloud-qualification.v1'; qualified: false; taskId: string | null;
  phase: 'preflight' | 'submission-pending' | 'submitted' | 'finished'; startedAt: string;
  request: { sourceRevision: string; model: string; effort: string; sampleDigest: string; environment: CloudQualificationOptions['environment']; settingsBinding: SettingsBinding | null };
  requestDigest: string; receiptDigest: string; cliVersion?: string;
  probes: { name: string; args: string[]; code: number; timedOut: boolean; overflow: boolean; durationMs: number; observedAt: string; output: string }[];
  checks: Record<'submission' | 'result' | 'actualModel' | 'actualEffort' | 'usage' | 'resume' | 'cancel' | 'remoteTimeout' | 'laptopIndependent' | 'entitlement' | 'expiryRecovery', QualificationCheck>;
  dependentRoutes: Record<'claude-subscription' | 'dot-chatgpt' | 'grok-research', QualificationCheck>;
  resultArtifact?: { bytes: string; digest: string } | null;
}
export const CLOUD_SAMPLE_PROMPT: string;
export function qualifyCodexCloud(options: CloudQualificationOptions): Promise<CloudQualificationReceipt>;
