import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);

export type DockerNetworkState = "internal" | "open" | "missing";

/** Read whether a Docker network exists and is internal. */
export async function inspectDockerNetwork(name: string): Promise<DockerNetworkState> {
  try {
    const { stdout } = await execute(
      "docker",
      ["network", "inspect", name, "--format", "{{.Internal}}"],
      {
        timeout: 5000,
      },
    );
    return stdout.trim() === "true" ? "internal" : "open";
  } catch (error) {
    const status = (error as { code?: number | string }).code;
    if (status === 1 || status === "1") return "missing";
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("No such network") || message.includes("not found")) return "missing";
    throw new Error(
      `Docker network ${name} must exist and be internal. Create it with the container setup step and restart the service.`,
    );
  }
}

export function assertInternalNetwork(name: string, state: DockerNetworkState): void {
  if (state === "internal") return;
  throw new Error(
    `Docker network ${name} must exist and be internal. Create it with the container setup step and restart the service.`,
  );
}
