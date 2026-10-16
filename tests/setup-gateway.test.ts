import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runSetupStep, type SetupContext } from "../setup/steps.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("bootstraps the pinned local gateway without a OneCLI CLI and repairs its relay on rerun", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-gateway-"));
  roots.push(root);
  await cp("examples", join(root, "examples"), { recursive: true });
  const commands: string[][] = [];
  let installed = false;
  let relayExists = false;
  let relayRunning = false;
  let connected = false;
  let relayTarget: string[] = [];
  let relayNetwork = "";
  const ctx: SetupContext = {
    root,
    home: join(root, "home"),
    env: {},
    platform: "darwin",
    uid: 501,
    nodePath: process.execPath,
    isTTY: false,
    prompt: async () => {
      throw new Error("Unexpected prompt");
    },
    log() {},
    async fetch(input) {
      const url = String(input);
      if (url.endsWith("/v1/health")) return new Response("{}", { status: installed ? 200 : 503 });
      expect(url).toBe(
        "https://raw.githubusercontent.com/onecli/onecli/v1.42.0/docker/docker-compose.yml",
      );
      return new Response(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal Docker Compose substitutions.
        'services:\n  onecli:\n    image: ghcr.io/onecli/onecli:${ONECLI_VERSION:-latest}\n    ports: ["${ONECLI_BIND_HOST:-127.0.0.1}:10254:10254"]\n    env_file:\n      - path: ../.env\n        required: false\n',
      );
    },
    async exec(command, args) {
      expect(command).toBe("docker");
      commands.push(args);
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      if (args[0] === "compose") {
        const file = args[args.indexOf("-f") + 1];
        const compose = await readFile(file, "utf8");
        expect(compose).toContain("ghcr.io/onecli/onecli:1.42.0");
        expect(compose).not.toContain("env_file");
        installed = true;
      } else if (args[0] === "inspect" && args[1] === "onecli") {
        return ok(JSON.stringify({ onecli_onecli: { IPAddress: "172.20.0.2" } }));
      } else if (args[0] === "inspect") {
        if (!relayExists) return { code: 1, stdout: "", stderr: "missing" };
        return ok(
          JSON.stringify({
            State: { Running: relayRunning },
            Config: { Cmd: relayTarget },
            HostConfig: { NetworkMode: relayNetwork, RestartPolicy: { Name: "unless-stopped" } },
            NetworkSettings: {
              Networks: connected ? { "mybots-isolated": { Aliases: ["onecli"] } } : {},
            },
          }),
        );
      } else if (args[0] === "run") {
        relayExists = relayRunning = true;
        relayTarget = args.slice(-2);
        relayNetwork = args[args.indexOf("--network") + 1];
        expect(args).toContain("unless-stopped");
        expect(relayTarget).toContain("TCP:172.20.0.2:10255");
      } else if (args[0] === "start") relayRunning = true;
      else if (args[0] === "network" && args[1] === "connect") connected = true;
      return ok();
    },
  };
  await runSetupStep("gateway", ctx);
  expect(installed && relayRunning && connected).toBe(true);
  expect(await readFile(join(root, ".env"), "utf8")).toContain("ONECLI_URL=http://127.0.0.1:10254");
  relayRunning = connected = false;
  await runSetupStep("gateway", ctx);
  expect(relayRunning && connected).toBe(true);
  expect(commands.filter((args) => args[0] === "compose")).toHaveLength(1);
});
