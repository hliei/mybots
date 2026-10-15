import type { SessionKey } from "@mybots/mailbox";

export interface GatewayContribution {
  env: Record<string, string>;
  trustFile: string;
}

export interface GatewayProvider {
  ensure(key: SessionKey, signal: AbortSignal): Promise<GatewayContribution>;
}
