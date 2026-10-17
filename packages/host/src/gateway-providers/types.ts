import type { SessionKey } from "@mybots/mailbox";
import type { GatewayTarget } from "../config/gateway-network.ts";

export interface GatewayContribution {
  env: Record<string, string>;
  trustFile: string;
  target?: GatewayTarget;
}

export interface GatewayProvider {
  ensure(key: SessionKey, signal: AbortSignal): Promise<GatewayContribution>;
}
