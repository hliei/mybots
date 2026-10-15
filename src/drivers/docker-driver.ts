import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { GatewayProvider } from "../gateway-providers/types.ts";
import { clearMailboxLocks } from "../mailbox/index.ts";
import type {
  ObservingSessionDriver,
  SessionHandle,
  SessionMaterial,
  SessionObservation,
} from "./types.ts";

const execute = promisify(execFile);

const legalName = (value: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(value);

export class DockerDriver implements ObservingSessionDriver {
  private readonly gateway: GatewayProvider;
  private readonly image: string;
  private readonly network: string;
  constructor(options: { gateway: GatewayProvider; image: string; network: string }) {
    this.gateway = options.gateway;
    this.image = options.image;
    this.network = options.network;
  }

  async start(material: SessionMaterial, signal: AbortSignal): Promise<SessionHandle> {
    signal.throwIfAborted();
    const contribution = await this.gateway.ensure(material.key, signal);
    const name = `mybots-${material.key.agentGroupId}-${material.key.sessionId}-${randomUUID()}`;
    let launched = false;
    try {
      if (
        !this.image ||
        !this.network ||
        !Object.keys(contribution.env).every((key) =>
          ["HTTPS_PROXY", "HTTP_PROXY", "NODE_EXTRA_CA_CERTS"].includes(key),
        )
      )
        throw new Error();
      if (
        !contribution.env.HTTPS_PROXY ||
        contribution.env.HTTP_PROXY !== contribution.env.HTTPS_PROXY ||
        contribution.env.NODE_EXTRA_CA_CERTS !== "/run/gateway/ca.pem"
      )
        throw new Error();
      const trust = await realpath(contribution.trustFile);
      await this.validatedPaths(material);
      if (!trust.startsWith(`${join(material.root, "data", "gateway-trust")}/`)) throw new Error();
      await execute("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 10000 });
      const network = await execute(
        "docker",
        ["network", "inspect", this.network, "--format", "{{.Internal}}"],
        { timeout: 10000 },
      );
      if (network.stdout.trim() !== "true") throw new Error();
      signal.throwIfAborted();
      // Caller has exclusively admitted this stopped session.
      clearMailboxLocks(material.directory);
      const args = [
        "run",
        "--detach",
        "--pull=never",
        "--name",
        name,
        "--network",
        this.network,
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--pids-limit=256",
        "--memory=1g",
        "--cpus=2",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=256m",
        "--workdir",
        "/workspace/group",
        "--env",
        "HOME=/tmp/agent",
        "--label",
        `mybots-agent-group=${material.key.agentGroupId}`,
        "--label",
        `mybots-session=${material.key.sessionId}`,
      ];
      for (const [hostPath, containerPath, readOnly] of [
        [material.directory, "/session", false],
        [join(material.directory, "inbound.db"), "/session/inbound.db", true],
        [material.workspace, "/workspace/group", false],
        [material.contextFile, "/run/mybots/context.json", true],
        [trust, "/run/gateway/ca.pem", true],
      ] as const) {
        if (hostPath.includes(",")) throw new Error();
        args.push(
          "--mount",
          `type=bind,source=${hostPath},target=${containerPath}${readOnly ? ",readonly" : ""}`,
        );
      }
      for (const [key, value] of Object.entries(contribution.env))
        args.push("--env", `${key}=${value}`);
      args.push(this.image);
      // Mark before spawning: even an uncertain Docker response owns cleanup by name.
      launched = true;
      await execute("docker", args, { timeout: 30000 });
      return await this.attach(name, material, signal);
    } catch {
      if (launched)
        await execute("docker", ["rm", "--force", name], { timeout: 15000 }).catch(() => {});
      throw new Error(
        "Docker session unavailable or invalid; check runtime, isolated network, image and declared mounts.",
      );
    }
  }

  /** Running session containers this runtime observes, independent of host memory. */
  async list(signal: AbortSignal): Promise<SessionObservation[]> {
    signal.throwIfAborted();
    let stdout: string;
    try {
      stdout = (
        await execute(
          "docker",
          [
            "ps",
            "--filter",
            "label=mybots-session",
            "--format",
            '{{.Names}}\t{{.Label "mybots-agent-group"}}\t{{.Label "mybots-session"}}',
          ],
          { timeout: 10000, signal },
        )
      ).stdout;
    } catch {
      if (signal.aborted) signal.throwIfAborted();
      throw new Error("Docker session observation unavailable");
    }
    const observations: SessionObservation[] = [];
    for (const line of stdout.split("\n")) {
      const [ref, agentGroupId, sessionId] = line.trim().split("\t");
      if (!ref || !agentGroupId || !sessionId) continue;
      if (!ref.startsWith("mybots-") || !legalName(agentGroupId) || !legalName(sessionId)) continue;
      observations.push({ key: { agentGroupId, sessionId }, ref });
    }
    return observations;
  }

  /** Take over an already-running session container instead of creating another. */
  async adopt(
    observation: SessionObservation,
    material: SessionMaterial,
    signal: AbortSignal,
  ): Promise<SessionHandle> {
    signal.throwIfAborted();
    if (
      observation.key.agentGroupId !== material.key.agentGroupId ||
      observation.key.sessionId !== material.key.sessionId ||
      !observation.ref.startsWith("mybots-")
    )
      throw new Error("Observed container does not belong to this session");
    await this.validatedPaths(material);
    let inspect: string;
    try {
      inspect = (
        await execute(
          "docker",
          [
            "inspect",
            "--format",
            '{{.State.Running}}\t{{index .Config.Labels "mybots-agent-group"}}\t{{index .Config.Labels "mybots-session"}}',
            observation.ref,
          ],
          { timeout: 10000, signal },
        )
      ).stdout.trim();
    } catch {
      if (signal.aborted) signal.throwIfAborted();
      throw new Error("Observed container is unavailable");
    }
    const [running, agentGroupId, sessionId] = inspect.split("\t");
    if (
      running !== "true" ||
      agentGroupId !== material.key.agentGroupId ||
      sessionId !== material.key.sessionId
    )
      throw new Error("Observed container does not match the session");
    return this.attach(observation.ref, material, signal);
  }

  private async validatedPaths(material: SessionMaterial): Promise<void> {
    const expectedDirectory = join(
      material.root,
      "data",
      "sessions",
      material.key.agentGroupId,
      material.key.sessionId,
    );
    const expectedWorkspace = join(material.root, "groups", material.folder);
    const expectedContext = join(
      material.root,
      "data",
      "sessions",
      material.key.agentGroupId,
      ".context",
      `${material.key.sessionId}.json`,
    );
    for (const [actual, expected] of [
      [material.directory, expectedDirectory],
      [material.workspace, expectedWorkspace],
      [material.contextFile, expectedContext],
    ]) {
      if (actual !== expected || (await realpath(actual)) !== expected) throw new Error();
    }
  }

  /** Bind a handle to one named container; stop/wait own its termination. */
  private async attach(
    name: string,
    material: SessionMaterial,
    signal: AbortSignal,
  ): Promise<SessionHandle> {
    let stopping: Promise<void> | undefined;
    const onAbort = () => {
      void stop().catch(() => {});
    };
    const stop = (): Promise<void> =>
      (stopping ??= (async () => {
        try {
          await execute("docker", ["stop", "--time", "5", name], { timeout: 15000 });
          await execute("docker", ["rm", name], { timeout: 10000 });
          clearMailboxLocks(material.directory);
        } catch {
          throw new Error("Docker session cleanup failed");
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      })());
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      await stop();
      signal.throwIfAborted();
    }
    return {
      ref: name,
      stop,
      wait: async () => {
        try {
          const result = await execute("docker", ["wait", name]);
          if (result.stdout.trim() !== "0") throw new Error();
        } catch {
          throw new Error("Docker Agent runner exited unsuccessfully");
        }
      },
    };
  }
}
