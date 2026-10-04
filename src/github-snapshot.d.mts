export type SourceBinding = Readonly<{ sha: string; ref: string; repo: string }>
export type ReviewVerdict = Readonly<{ verdict: "APPROVE" | "BLOCK" | "REVIEW: BLOCKED" | "CHANGES REQUESTED"; sha: string; body: string }>
export type Comment = Readonly<{ id: number; body: string; user: { login: string }; created_at: string; updated_at: string }>
export type SnapshotError = Readonly<{ message: string; transient: boolean }>
type Observation = Readonly<{
  schema: "factory-github-snapshot/v1"; observationId: string; repo: string; pr: number; startedAt: string; fetchedAt: string;
  metrics: Readonly<{ providerCalls: number; staleActions: number }>;
}>
export type UnknownSnapshot = Observation & Readonly<{
  state: "unknown"; review: null; errors: readonly SnapshotError[];
  ci: Readonly<{ state: "provider-unknown"; nextAction: "retry-provider-observation" }>;
}>
export type KnownSnapshot = Observation & Readonly<{
  state: "known"; prState: "OPEN" | "CLOSED" | "MERGED"; number: number; title: string;
  head: SourceBinding; base: SourceBinding; headRefOid: string; baseRefOid: string;
  headRefName: string; baseRefName: string; isCrossRepository: boolean; isDraft: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN"; mergeStateStatus: string;
  mergeCommit: Readonly<{ oid: string | null }>; commentCount: number; updatedAt: string | null;
  comments: readonly Comment[]; review: ReviewVerdict | null; errors: readonly [];
  ci: Readonly<{ state: "success" | "pending" | "failure" | "superseded"; nextAction: string; [key: string]: unknown }>;
  inventory: Readonly<{ comments: readonly Comment[]; checkRuns: readonly Record<string, unknown>[];
    statuses: readonly Record<string, unknown>[]; requiredChecks: readonly { name: string; appId?: number }[] }>;
}>
export type RefusedSnapshot = Omit<KnownSnapshot, "state" | "ci" | "inventory"> & Readonly<{
  state: "refused"; reason: "no-current-trusted-approval";
  ci: Readonly<{ state: "unobserved"; nextAction: "await-trusted-review" }>;
  inventory: Readonly<{ comments: readonly Comment[]; checkRuns: null; statuses: null;
    requiredChecks: readonly { name: string; appId?: number }[] }>;
}>
export type GithubSnapshot = KnownSnapshot | UnknownSnapshot | RefusedSnapshot
export function parseReview(body: string): ReviewVerdict | null
export function latestTrustedReview(comments: readonly Comment[], trustedReviewers: readonly string[],
  authenticate: (candidate: ReviewVerdict) => Promise<boolean>): Promise<ReviewVerdict | null>
export function createGithubProvider(config: { retryMs: number; commandTimeoutMs: number }, dependencies: {
  command: (argv: string[], cwd: string, options: { allowFailure: boolean; maxOutputBytes: number }) =>
    Promise<{ code: number; stdout: string; timedOut?: boolean }>;
  getRepo: (repo: string) => { checkout: string; trustedReviewers: string[]; requiredChecks: { name: string; appId?: number }[] };
  authenticate: (repo: string, pr: number, candidate: ReviewVerdict) => Promise<boolean>;
  now?: () => number;
}): {
  snapshot: (repo: string, pr: number, options?: { head?: string; requireApproval?: boolean }) => Promise<GithubSnapshot>;
  pages: (repo: string, route: string, options?: { field?: string; expected?: number; metrics?: { providerCalls: number } }) => Promise<Record<string, unknown>[]>;
  request: (repo: string, route: string, options?: { method?: string; fields?: Record<string, string>; metrics?: { providerCalls: number } }) => Promise<{ value: unknown; headers: string }>;
}
