import { execFile } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocketChannel } from "../packages/host/src/channels/websocket.ts";
import { loadHostSettings } from "../packages/host/src/config/host.ts";
import { Host } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

const run = promisify(execFile);
let root: string;
let host: Host | undefined;
let channel: WebSocketChannel | undefined;
afterEach(async () => {
  await channel?.close();
  channel = undefined;
  await host?.stop();
  host = undefined;
  if (root) {
    try {
      const pid = Number(await readFile(join(root, "service-pid"), "utf8"));
      process.kill(pid, "SIGTERM");
      await vi.waitFor(async () =>
        expect(await readFile(join(root, "service-stopped"), "utf8")).toBe("stopped"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function installed() {
  root = await mkdtemp(join(tmpdir(), "mybots-start-"));
  await copyFile("examples/host/host.json", join(root, "host.json"));
  const { configuration } = await loadHostSettings(join(root, "host.json"));
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  channel = await WebSocketChannel.listen({ root, host, configuration, port: 0 });
  const url = `http://127.0.0.1:${channel.address.port}/`;
  const settings = JSON.parse(await readFile(join(root, "host.json"), "utf8"));
  settings.websocket.port = channel.address.port;
  await writeFile(join(root, "host.json"), JSON.stringify(settings));
  const commands = join(root, "commands");
  await mkdir(commands);
  await writeFile(join(commands, "open"), `#!/bin/sh\nprintf '%s\\n' "$@" > '${root}/opened'\n`, {
    mode: 0o755,
  });
  await copyFile(join(commands, "open"), join(commands, "xdg-open"));
  await writeFile(join(commands, "launchctl"), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
  await copyFile(join(commands, "launchctl"), join(commands, "systemctl"));
  return {
    url,
    env: {
      ...process.env,
      PATH: `${commands}:${process.env.PATH}`,
      NODE_OPTIONS: "--conditions=mybots-source",
    },
  };
}

it("opens the paired local UI without restarting an already running Host", async () => {
  const { url, env } = await installed();
  const result = await run(resolve("bin/mbt"), ["start", "--root", root], {
    cwd: tmpdir(),
    env,
    timeout: 5000,
  });
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(url);
  expect((await readFile(join(root, "opened"), "utf8")).trim()).toBe(url);
  const credential = (await readFile(join(root, "data", "client-credential"), "utf8")).trim();
  expect(result.stdout).not.toContain(credential);
  expect((await host?.clientStatus())?.sessions).toEqual([]);
});

it.each([true, false])(
  "starts the installed service (loaded: %s), waits for its API and opens the UI",
  async (loaded) => {
    const { url, env } = await installed();
    await channel?.close();
    channel = undefined;
    await host?.stop();
    host = undefined;
    const commands = join(root, "commands");
    const script = `#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(root + '/service-commands', JSON.stringify(args) + '\\n');
if (args[0] === 'print') process.exit(${loaded ? 0 : 1});
if (args.includes('start') || args[0] === 'kickstart' || args[0] === 'bootstrap') {
  const child = spawn(process.execPath, [${JSON.stringify(resolve("tests/start-command-host.ts"))}, root], { stdio: 'ignore', detached: true, env: { ...process.env, NODE_OPTIONS: '--conditions=mybots-source' } });
  writeFileSync(root + '/service-pid', String(child.pid));
  child.unref();
}
`;
    await writeFile(join(commands, "launchctl"), script, { mode: 0o755 });
    await copyFile(join(commands, "launchctl"), join(commands, "systemctl"));
    const result = await run(resolve("bin/mbt"), ["start", "--root", root], {
      cwd: tmpdir(),
      env,
      timeout: 10000,
    });
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(url);
    expect((await readFile(join(root, "opened"), "utf8")).trim()).toBe(url);
    expect(await readFile(join(root, "service-commands"), "utf8")).not.toContain('"-k"');
  },
  15000,
);

it("uses the installation's Node through a linked command without changing the caller's directory", async () => {
  const { url, env } = await installed();
  const installation = join(root, "linked install");
  await mkdir(join(installation, "bin"), { recursive: true });
  await mkdir(join(installation, ".tools/node/bin"), { recursive: true });
  await mkdir(join(installation, "packages/host/src/cli"), { recursive: true });
  await copyFile(resolve("bin/mbt"), join(installation, "bin/mbt"));
  await copyFile(
    resolve("packages/host/src/cli/client.ts"),
    join(installation, "packages/host/src/cli/client.ts"),
  );
  for (const file of ["chat.ts", "start.ts"])
    await symlink(
      resolve(`packages/host/src/cli/${file}`),
      join(installation, `packages/host/src/cli/${file}`),
    );
  await symlink(join(root, "host.json"), join(installation, "host.json"));
  await symlink(join(root, "data"), join(installation, "data"));
  await writeFile(
    join(installation, ".tools/node/bin/node"),
    `#!/bin/sh\npwd > '${root}/node-cwd'\nexec '${process.execPath}' "$@"\n`,
    { mode: 0o755 },
  );
  const command = join(root, "commands/mbt");
  await symlink("../linked install/bin/mbt", command);
  await run(command, ["start"], { cwd: tmpdir(), env, timeout: 10000 });
  expect((await readFile(join(root, "node-cwd"), "utf8")).trim()).toBe(await realpath(tmpdir()));
  expect((await readFile(join(root, "opened"), "utf8")).trim()).toBe(url);
}, 15000);

it("reports a missing installed service without opening the browser or rewriting configuration", async () => {
  const { env } = await installed();
  const settings = await readFile(join(root, "host.json"), "utf8");
  await channel?.close();
  channel = undefined;
  await host?.stop();
  host = undefined;
  const result = await run(resolve("bin/mbt"), ["start", "--root", root], {
    cwd: tmpdir(),
    env,
    timeout: 5000,
  }).catch((error) => error as { code: number; stderr: string });
  expect(result).toMatchObject({
    code: 1,
    stderr: expect.stringContaining("Run bash mybots.sh once"),
  });
  expect(await readFile(join(root, "host.json"), "utf8")).toBe(settings);
  await expect(readFile(join(root, "opened"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["disabled", "ephemeral", "remote"])(
  "rejects an unusable %s Web listener before service or browser changes",
  async (mode) => {
    const { env } = await installed();
    const settings = JSON.parse(await readFile(join(root, "host.json"), "utf8"));
    if (mode === "disabled") delete settings.websocket;
    if (mode === "ephemeral") settings.websocket.port = 0;
    if (mode === "remote") settings.websocket.host = "0.0.0.0";
    await writeFile(join(root, "host.json"), JSON.stringify(settings));
    const result = await run(resolve("bin/mbt"), ["start", "--root", root], {
      cwd: tmpdir(),
      env,
      timeout: 5000,
    }).catch((error) => error as { code: number; stderr: string });
    expect(result).toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Cannot start Mybots"),
    });
    await expect(readFile(join(root, "opened"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("keeps a ready Host usable and prints its URL when no desktop browser can open", async () => {
  const { env, url } = await installed();
  for (const command of ["open", "xdg-open"])
    await writeFile(join(root, "commands", command), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const result = await run(resolve("bin/mbt"), ["start", "--root", root], {
    cwd: tmpdir(),
    env,
    timeout: 5000,
  });
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(`Open ${url} in your browser.`);
});

it("shows start help without reading installation state or launching services", async () => {
  root = await mkdtemp(join(tmpdir(), "mybots-start-help-"));
  const result = await run(resolve("bin/mbt"), ["start", "--help", "--root", root], {
    cwd: tmpdir(),
    timeout: 5000,
  });
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("mbt start");
  expect(await readdir(root)).toEqual([]);
});
