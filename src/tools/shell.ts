import { spawn } from "node:child_process";

export async function runShell(command: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = spawn(command, {
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let failure: string | undefined;
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });

  function kill(signal: NodeJS.Signals) {
    try {
      // On POSIX, include descendants that inherited the shell's process group.
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  function stop(message: string) {
    if (failure) return;
    failure = message;
    kill("SIGTERM");
    forceKill = setTimeout(() => kill("SIGKILL"), 1000);
  }
  const abort = () => stop("Error executing command: cancelled.");
  const timeout = setTimeout(
    () => stop("Error executing command: timed out after 60000ms."),
    60_000,
  );
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  return await new Promise<string>((resolve) => {
    child.once("error", (error) => {
      failure = `Error executing command: ${error.message}`;
    });
    child.once("close", () => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      signal?.removeEventListener("abort", abort);
      if (failure) kill("SIGKILL");
      resolve(
        failure ??
          (stdout && stderr
            ? `${stdout}\n${stderr}`
            : stdout || stderr || "Command completed with no output"),
      );
    });
  });
}
