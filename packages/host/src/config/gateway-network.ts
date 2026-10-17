import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface GatewayTarget {
  container: string;
  alias: string;
}

/** Repair attachment after gateway recreation, before admitting session execution. */
export async function connectGateway(
  target: GatewayTarget & { network: string },
  docker: (args: string[]) => Promise<{ stdout: string }> = (args) =>
    execute("docker", args, { timeout: 10000 }),
): Promise<void> {
  try {
    const { container, network, alias } = target;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(container) || !/^[a-zA-Z0-9.-]+$/.test(alias))
      throw new Error();
    const internal = await docker(["network", "inspect", network, "--format", "{{.Internal}}"]);
    if (internal.stdout.trim() !== "true") throw new Error();
    for (let attempt = 0; attempt < 3; attempt++) {
      const inspected = await docker(["inspect", container, "--format", "{{json .}}"]);
      const gateway = JSON.parse(inspected.stdout) as {
        State: { Running: boolean };
        NetworkSettings: { Networks: Record<string, { IPAddress?: string; Aliases?: string[] }> };
      };
      const networks = gateway.NetworkSettings.Networks;
      if (
        !gateway.State.Running ||
        !Object.entries(networks).some(([name, value]) => name !== network && value.IPAddress)
      )
        throw new Error();
      const attached = networks[network];
      if (attached?.IPAddress && attached.Aliases?.includes(alias)) return;
      // The last observation verifies a concurrent caller's completed repair.
      if (attempt === 2) throw new Error();
      try {
        if (attached) await docker(["network", "disconnect", network, container]);
        await docker(["network", "connect", "--alias", alias, network, container]);
        return;
      } catch {
        // Another session may have changed this shared attachment. Re-read it.
      }
    }
  } catch {
    throw new Error(
      "Direct OneCLI network attachment failed; check the running local gateway, separate backend and internal session network. No direct Internet fallback is available.",
    );
  }
}
