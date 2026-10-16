import type { DesignStation, ModelMode } from './design-manager.mjs'
export type DesignWorkerRoute = 'codex-cloud' | 'claude-subscription' | 'dot-chatgpt' | 'grok-research'
export type DesignEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'
export interface DesignWorker {
  provider: 'codex' | 'claude' | 'dot' | 'grok'; model: string; effort: DesignEffort;
  concurrency: number; availability: 'available' | 'unavailable'; allowedRoutes: DesignWorkerRoute[];
}
export interface DesignWorkerAllocation {
  workerId: string; purpose: 'work' | 'judgment' | 'review' | 'x-research'; route: DesignWorkerRoute;
}
export interface DesignUserSettings {
  schema: 'design-settings.v1'; userId: string; version: number;
  workers: Record<string, DesignWorker>;
  stations: Record<DesignStation, DesignWorkerAllocation[]>;
  modes: Record<ModelMode, Record<string, { model: string; effort: DesignEffort }>>;
}
export type DeepReadonly<T> = T extends object ? { readonly [P in keyof T]: DeepReadonly<T[P]> } : T;
export interface ResolvedDesignSettings { readonly profile: DeepReadonly<DesignUserSettings>; readonly digest: string }
export interface ResolvedDesignAssignment {
  readonly userId: string; readonly version: number; readonly settingsDigest: string;
  readonly station: DesignStation; readonly mode: ModelMode;
  readonly assignments: readonly Readonly<DesignWorkerAllocation & Omit<DesignWorker, 'allowedRoutes'>>[];
}
export function resolveDesignSettings(profile: DesignUserSettings | DeepReadonly<DesignUserSettings>): ResolvedDesignSettings;
export function loadDesignSettings(file?: string): Promise<ResolvedDesignSettings>;
export function resolveDesignAssignment(settings: ResolvedDesignSettings, selection: { station: DesignStation; mode: ModelMode }): ResolvedDesignAssignment;
