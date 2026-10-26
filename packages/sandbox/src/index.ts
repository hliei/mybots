import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export interface ComputerRef {
  id: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface CommandOwner {
  botId: string;
  turnId: string;
}

export interface CommandSnapshot extends Omit<CommandResult, "exitCode"> {
  commandId: string;
  exitCode: number | null;
  running: boolean;
  service: boolean;
  retained: boolean;
  owner: CommandOwner | null;
}

export function commandTimeoutMs(value = process.env.SANDBOX_COMMAND_TIMEOUT_MS): number {
  const timeout = Number(value);
  return Number.isSafeInteger(timeout) && timeout > 0 && timeout <= 3600000 ? timeout : 300000;
}

export interface SandboxProvider {
  prepare(computer: ComputerRef): Promise<void>;
  execute(
    computer: ComputerRef,
    command: string,
    cwd: string,
    signal?: AbortSignal,
    options?: { onOutput?: (text: string) => void },
  ): Promise<CommandResult>;
  startCommand(
    computer: ComputerRef,
    command: string,
    cwd: string,
    owner: CommandOwner,
    service: boolean,
    signal?: AbortSignal,
  ): Promise<CommandSnapshot>;
  observeCommand(
    computer: ComputerRef,
    id: string,
    botId?: string,
    signal?: AbortSignal,
    onOutput?: (text: string) => void,
    untilExit?: boolean,
  ): Promise<CommandSnapshot>;
  listCommands(computer: ComputerRef): Promise<CommandSnapshot[]>;
  cancelCommand(computer: ComputerRef, id: string, botId?: string): Promise<void>;
  finishTurn(computer: ComputerRef, owner: CommandOwner, completed: boolean): Promise<void>;
  listFiles(computer: ComputerRef, path: string, signal?: AbortSignal): Promise<string>;
  readFile(computer: ComputerRef, path: string, signal?: AbortSignal): Promise<string>;
  writeFile(
    computer: ComputerRef,
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void>;
  exportWorkspace(computer: ComputerRef): Promise<Uint8Array>;
  importWorkspace(computer: ComputerRef, archive: Uint8Array): Promise<void>;
}

export function resolveWorkingPath(botId: string, requested = "."): string {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(botId)) throw new Error("Invalid Bot identity");
  if (typeof requested !== "string" || requested.length > 4096 || /[\0\\]/.test(requested))
    throw new Error("Invalid workspace path");
  const parts = requested.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw new Error("Path escapes the Computer workspace");
  const path = parts.join("/");
  return requested.startsWith("/") || parts[0] === "shared" || parts[0] === "bots"
    ? path
    : [`bots/${botId}`, path].filter(Boolean).join("/");
}

const image = "mybots-computer:local";
const maxTransferBytes = 16 * 1024 * 1024;

async function docker(args: string[], input?: Uint8Array): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: "pipe" });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let errorText = "";
    let failure: Error | undefined;
    const timeout = setTimeout(() => {
      failure = new Error("Docker operation timed out");
      child.kill("SIGKILL");
    }, 150000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > maxTransferBytes * 2) {
        failure = new Error("Docker output exceeds transfer limit");
        child.kill("SIGKILL");
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorText = (errorText + chunk.toString()).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`Docker operation failed: ${errorText}`));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

export class DockerSandbox implements SandboxProvider {
  private preparing: Promise<void> | undefined;
  private readonly computer: ComputerRef;
  private readonly workspace: string;

  constructor(computer: ComputerRef, workspace: string) {
    if (!/^mybots-[a-f0-9-]{36}$/.test(computer.id)) throw new Error("Invalid Computer identity");
    if (!isAbsolute(workspace) || /[,\0]/.test(workspace))
      throw new Error("Invalid workspace mount");
    this.computer = computer;
    this.workspace = workspace;
  }

  async prepare(computer: ComputerRef): Promise<void> {
    this.check(computer);
    if (!this.preparing)
      this.preparing = this.provision().finally(() => {
        this.preparing = undefined;
      });
    await this.preparing;
  }

  private check(computer: ComputerRef): void {
    if (computer.id !== this.computer.id) throw new Error("Unknown Computer");
  }

  private async provision(): Promise<void> {
    await mkdir(this.workspace, { recursive: true });
    const containers = (await docker(["container", "ls", "-a", "--format", "{{.Names}}"]))
      .toString()
      .split("\n");
    if (!containers.includes(this.computer.id)) {
      await docker([
        "run",
        "-d",
        "--name",
        this.computer.id,
        "--label",
        "mybots.team-computer=true",
        "--init",
        "--read-only",
        "--tmpfs",
        "/tmp:rw,nosuid,size=256m",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "256",
        "--mount",
        `type=bind,source=${this.workspace},target=/workspace`,
        image,
      ]);
    } else {
      // Refuse to attach an unrelated container with a coincidentally matching name.
      const [info] = JSON.parse((await docker(["inspect", this.computer.id])).toString()) as Array<{
        Config: { Labels: Record<string, string> };
        Mounts: { Source: string; Destination: string; RW: boolean }[];
      }>;
      if (
        info?.Config.Labels["mybots.team-computer"] !== "true" ||
        info.Mounts.length !== 1 ||
        !info.Mounts.some(
          (mount) =>
            mount.Source === this.workspace && mount.Destination === "/workspace" && mount.RW,
        )
      )
        throw new Error("Computer mount or ownership mismatch");
      await docker(["start", this.computer.id]);
    }
  }

  private async call(computer: ComputerRef, request: Record<string, unknown>): Promise<Buffer> {
    this.check(computer);
    return docker(
      ["exec", "-i", computer.id, "python3", "/opt/mybots/computer.py"],
      Buffer.from(JSON.stringify(request)),
    );
  }

  private async launch(
    computer: ComputerRef,
    command: string,
    cwd: string,
    owner?: CommandOwner,
    service = false,
    signal?: AbortSignal,
  ): Promise<CommandSnapshot> {
    if (
      typeof command !== "string" ||
      !command.trim() ||
      command.length > 65536 ||
      command.includes("\0")
    )
      throw new Error("Invalid shell command");
    signal?.throwIfAborted();
    await this.prepare(computer);
    signal?.throwIfAborted();
    const id = randomUUID();
    const result = await this.call(computer, {
      action: "start",
      command,
      cwd,
      id,
      owner,
      service,
      timeoutMs: commandTimeoutMs(),
    });
    if (signal?.aborted) {
      await this.cancelCommand(computer, id);
      signal.throwIfAborted();
    }
    return JSON.parse(result.toString()) as CommandSnapshot;
  }

  async startCommand(
    computer: ComputerRef,
    command: string,
    cwd: string,
    owner: CommandOwner,
    service: boolean,
    signal?: AbortSignal,
  ): Promise<CommandSnapshot> {
    return this.launch(computer, command, cwd, owner, service, signal);
  }

  async observeCommand(
    computer: ComputerRef,
    id: string,
    botId?: string,
    signal?: AbortSignal,
    onOutput?: (text: string) => void,
    untilExit = false,
  ): Promise<CommandSnapshot> {
    let stdout = "";
    let stderr = "";
    let changedAt = Date.now();
    const startedAt = Date.now();
    while (true) {
      signal?.throwIfAborted();
      const result = JSON.parse(
        (await this.call(computer, { action: "snapshot", id, botId })).toString(),
      ) as CommandSnapshot;
      if (result.stdout !== stdout || result.stderr !== stderr) {
        onOutput?.(result.stdout.slice(stdout.length) + result.stderr.slice(stderr.length));
        stdout = result.stdout;
        stderr = result.stderr;
        changedAt = Date.now();
      }
      if (
        !result.running ||
        (!untilExit &&
          ((stdout.length + stderr.length > 0 && Date.now() - changedAt >= 1000) ||
            Date.now() - startedAt >= 10000))
      )
        return result;
      await delay(200, undefined, { signal });
    }
  }

  async execute(
    computer: ComputerRef,
    command: string,
    cwd: string,
    signal?: AbortSignal,
    options?: { onOutput?: (text: string) => void },
  ): Promise<CommandResult> {
    const { commandId } = await this.launch(computer, command, cwd, undefined, false, signal);
    let finished = false;
    try {
      const result = await this.observeCommand(
        computer,
        commandId,
        undefined,
        signal,
        options?.onOutput,
        true,
      );
      if (result.exitCode === null) throw new Error("Command has not exited");
      finished = true;
      return { ...result, exitCode: result.exitCode };
    } catch (error) {
      await this.cancelCommand(computer, commandId);
      finished = true;
      throw error;
    } finally {
      if (finished) await this.call(computer, { action: "release", id: commandId });
    }
  }

  async listCommands(computer: ComputerRef): Promise<CommandSnapshot[]> {
    this.check(computer);
    const running = (
      await docker([
        "container",
        "ls",
        "--filter",
        `name=^/${computer.id}$`,
        "--format",
        "{{.Names}}",
      ])
    )
      .toString()
      .trim();
    if (!running) return [];
    return JSON.parse(
      (await this.call(computer, { action: "commands" })).toString(),
    ) as CommandSnapshot[];
  }

  async cancelCommand(computer: ComputerRef, id: string, botId?: string): Promise<void> {
    await this.call(computer, { action: "cancel", id, botId });
  }

  async finishTurn(computer: ComputerRef, owner: CommandOwner, completed: boolean): Promise<void> {
    await this.call(computer, { action: "finish_turn", owner, completed });
  }

  async listFiles(computer: ComputerRef, path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    await this.prepare(computer);
    signal?.throwIfAborted();
    return (await this.call(computer, { action: "list", path })).toString();
  }

  async readFile(computer: ComputerRef, path: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    await this.prepare(computer);
    signal?.throwIfAborted();
    return (await this.call(computer, { action: "read", path })).toString();
  }

  async writeFile(
    computer: ComputerRef,
    path: string,
    content: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (typeof content !== "string" || Buffer.byteLength(content) > 1024 * 1024)
      throw new Error("File exceeds 1 MiB limit");
    signal?.throwIfAborted();
    await this.prepare(computer);
    signal?.throwIfAborted();
    await this.call(computer, { action: "write", path, content });
  }

  async exportWorkspace(computer: ComputerRef): Promise<Uint8Array> {
    await this.prepare(computer);
    return this.call(computer, { action: "export" });
  }

  async importWorkspace(computer: ComputerRef, archive: Uint8Array): Promise<void> {
    if (archive.byteLength > maxTransferBytes) throw new Error("Archive exceeds 16 MiB limit");
    await this.prepare(computer);
    await this.call(computer, {
      action: "import",
      archive: Buffer.from(archive).toString("base64"),
    });
  }
}
