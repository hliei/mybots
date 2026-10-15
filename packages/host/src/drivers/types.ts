import type { SessionKey } from "@mybots/mailbox";

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
  /** Runtime identity observed for this container, when the driver exposes one. */
  ref?: string;
  /** Stops and removes this container; awaits termination before cleanup. */
  stop(): Promise<void>;
  /** Resolves only when the runtime exits. */
  wait(): Promise<void>;
}

/** A running session container observed in the runtime rather than in host memory. */
export interface SessionObservation {
  key: SessionKey;
  ref: string;
}

export interface SessionDriver {
  start(material: SessionMaterial, signal: AbortSignal): Promise<SessionHandle>;
}

/** A driver that can observe and take over containers left by an earlier host. */
export interface ObservingSessionDriver extends SessionDriver {
  list(signal: AbortSignal): Promise<SessionObservation[]>;
  adopt(
    observation: SessionObservation,
    material: SessionMaterial,
    signal: AbortSignal,
  ): Promise<SessionHandle>;
}

export function observesSessions(driver: SessionDriver): driver is ObservingSessionDriver {
  const candidate = driver as Partial<ObservingSessionDriver>;
  return typeof candidate.list === "function" && typeof candidate.adopt === "function";
}
