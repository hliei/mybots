import type { SessionKey } from "../mailbox/types.ts";

export interface GatewayContribution {
  env: Record<string, string>;
  trustFile: string;
}

export interface GatewayProvider {
  ensure(key: SessionKey, signal: AbortSignal): Promise<GatewayContribution>;
}
