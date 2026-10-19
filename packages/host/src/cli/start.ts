import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm } from "node:fs/promises";
import { get } from "node:http";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { loadHostSettings } from "../config/host.ts";
import { installSlug, serviceLabel, serviceUnitName } from "../config/service.ts";

const execute = promisify(execFile);

/** Kernel-released lock for start/exit, separate from the running Host's database. */
async function serviceControl(root: string, operation: () => Promise<void>): Promise<void> {
  await mkdir(join(root, "data"), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = await import("node:sqlite");
  const guard = new DatabaseSync(join(root, "data", "service-control.lock"));
  try {
    const deadline = Date.now() + 60000;
    while (true) {
      try {
        guard.exec("BEGIN EXCLUSIVE");
        break;
      } catch (error) {
        if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline)
          throw new Error("Another Mybots start/exit operation has not finished. Retry shortly.");
        await setTimeout(100);
      }
    }
    try {
      await operation();
    } finally {
      guard.exec("ROLLBACK");
    }
  } finally {
    guard.close();
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid || !Number.isSafeInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ownerPid(root: string): Promise<number | undefined> {
  try {
    const owner: unknown = JSON.parse(
      await readFile(join(root, "data", "host.lock", "owner.json"), "utf8"),
    );
    if (
      owner &&
      typeof owner === "object" &&
      "pid" in owner &&
      typeof owner.pid === "number" &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 1
    )
      return owner.pid;
    throw new Error("Invalid Host ownership record; shutdown cannot be confirmed.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function stopService(root: string, pid: number | undefined): Promise<void> {
  const slug = installSlug(root, process.env.MYBOTS_INSTALL_ID || undefined);
  const options = { cwd: root, timeout: 20000 };
  if (process.platform === "darwin") {
    const job = `gui/${userInfo().uid}/${serviceLabel(slug)}`;
    try {
      await execute("launchctl", ["print", job], options);
    } catch {
      return;
    }
    await execute("launchctl", ["bootout", job], options);
  } else if (process.platform === "linux" && !existsSync(join(root, "start-mybots.sh"))) {
    const prefix = userInfo().uid === 0 ? [] : ["--user"];
    try {
      await execute("systemctl", [...prefix, "stop", serviceUnitName(slug)], options);
    } catch {
      try {
        await execute(
          "systemctl",
          [...prefix, "is-active", "--quiet", serviceUnitName(slug)],
          options,
        );
      } catch (error) {
        if ([3, 4].includes((error as { code: number }).code)) return;
        throw error;
      }
      throw new Error("The installed Mybots service did not stop.");
    }
  } else {
    const recorded = Number(await readFile(join(root, "mybots.pid"), "utf8").catch(() => ""));
    if (!alive(recorded)) return;
    if (recorded !== pid)
      throw new Error(
        "Host ownership does not match the installed process; shutdown cannot be confirmed.",
      );
    process.kill(recorded, "SIGTERM");
  }
}

async function startService(root: string): Promise<void> {
  const slug = installSlug(root, process.env.MYBOTS_INSTALL_ID || undefined);
  const options = { cwd: root, timeout: 10000 };
  if (process.platform === "darwin") {
    const domain = `gui/${userInfo().uid}`;
    const label = serviceLabel(slug);
    try {
      await execute("launchctl", ["print", `${domain}/${label}`], options);
    } catch {
      try {
        await execute(
          "launchctl",
          ["bootstrap", domain, join(homedir(), "Library", "LaunchAgents", `${label}.plist`)],
          options,
        );
      } catch {
        // Concurrent starts can both observe an unloaded job; the first bootstrap wins.
        await execute("launchctl", ["print", `${domain}/${label}`], options);
      }
      return;
    }
    await execute("launchctl", ["kickstart", `${domain}/${label}`], options);
  } else if (process.platform === "linux" && !existsSync(join(root, "start-mybots.sh"))) {
    await execute(
      "systemctl",
      [...(userInfo().uid === 0 ? [] : ["--user"]), "start", serviceUnitName(slug)],
      options,
    );
  } else {
    const pid = Number(await readFile(join(root, "mybots.pid"), "utf8").catch(() => ""));
    let running = false;
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        running = true;
      } catch {
        /* The saved process has exited. */
      }
    }
    if (!running) await execute("bash", [join(root, "start-mybots.sh")], options);
  }
}

async function ready(root: string, url: string): Promise<boolean> {
  let credential: string;
  try {
    credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
    if (!credential) return false;
  } catch {
    return false;
  }
  return new Promise((resolve) => {
    const request = get(
      new URL("api/status", url),
      {
        headers: { Authorization: `Bearer ${credential}` },
        signal: AbortSignal.timeout(1000),
      },
      (response) => {
        response.resume();
        response.once("end", () => resolve(response.statusCode === 200));
        response.once("error", () => resolve(false));
      },
    );
    request.once("error", () => resolve(false));
  });
}

/** Start the installed Host service and open its authenticated local client. */
export async function startClient(root: string): Promise<number> {
  try {
    root = await realpath(root);
    const settings = await loadHostSettings(join(root, "host.json"));
    if (!settings.websocket || settings.websocket.port === 0)
      throw new Error("Configure a fixed loopback Web port before using mbt start.");
    const { host, port } = settings.websocket;
    const url = `http://${host === "::1" ? "[::1]" : host}:${port}/`;
    await serviceControl(root, async () => {
      if (!(await ready(root, url))) {
        console.log("Starting the installed Mybots service…");
        try {
          await startService(root);
        } catch {
          throw new Error(
            "Cannot start the installed service. Run bash mybots.sh once to install it, then retry mbt start.",
          );
        }
        const deadline = Date.now() + 30000;
        while (!(await ready(root, url))) {
          if (Date.now() >= deadline)
            throw new Error(
              `Host did not become ready. Check Docker, the gateway and ${join(root, "logs", "mybots.error.log")}.`,
            );
          await setTimeout(200);
        }
      }
      console.log(`Mybots is ready: ${url}`);
      try {
        await execute(process.platform === "darwin" ? "open" : "xdg-open", [url], {
          timeout: 5000,
        });
      } catch {
        console.log(`Open ${url} in your browser.`);
      }
    });
    return 0;
  } catch (error) {
    console.error(
      `Cannot start Mybots: ${error instanceof Error ? error.message : "Startup failed."}`,
    );
    return 1;
  }
}

/** Unload/stop this installation and await its normal session-container cleanup. */
export async function exitClient(root: string): Promise<number> {
  try {
    root = await realpath(root);
    await serviceControl(root, async () => {
      const pid = await ownerPid(root);
      await stopService(root, pid);
      const deadline = Date.now() + 30000;
      while (alive(pid) || existsSync(join(root, "data", "host.lock"))) {
        if (!alive(pid) && existsSync(join(root, "data", "host.lock")))
          throw new Error(
            `Host stopped but session cleanup is unconfirmed. Check ${join(root, "logs", "mybots.error.log")}.`,
          );
        if (Date.now() >= deadline)
          throw new Error(
            `Host is still stopping; cleanup is unconfirmed. Check ${join(root, "logs", "mybots.error.log")}.`,
          );
        await setTimeout(100);
      }
      await rm(join(root, "mybots.pid"), { force: true });
      console.log(
        "Mybots stopped. Session containers are released; shared gateway and saved data are retained.",
      );
    });
    return 0;
  } catch (error) {
    console.error(
      `Cannot exit Mybots: ${error instanceof Error ? error.message : "Shutdown failed."}`,
    );
    return 1;
  }
}
