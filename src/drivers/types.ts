import type { SessionKey } from "../mailbox/types.ts";

export interface ModelConfiguration {
  provider: string;
  id: string;
  baseUrl: string;
  contextWindow: number;
  maxTokens: number;
}

export interface SessionMaterial {
  root: string;
  key: SessionKey;
  folder: string;
  directory: string;
  workspace: string;
  contextFile: string;
}

export interface SessionHandle {
  /** Stops and removes this container; awaits termination before cleanup. */
  stop(): Promise<void>;
  /** Resolves only when the runtime exits. */
  wait(): Promise<void>;
}

export interface SessionDriver {
  start(material: SessionMaterial, signal: AbortSignal): Promise<SessionHandle>;
}
