import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { installSlug } from "../setup/service-files.ts";
import { runSetupStep, type SetupContext } from "../setup/steps.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "mybots-gateway-"));
  roots.push(root);
  await cp("examples", join(root, "examples"), { recursive: true });
  const commands: string[][] = [];
  const state = {
    installed: false,
    connected: false,
    alias: "onecli",
    relay: false,
    relayAttached: true,
    probeFailure: "",
    foreignRelay: false,
    connectFailure: false,
  };
  const name = `mybots-relay-${installSlug(root)}`;
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
      if (String(input).endsWith("/v1/health"))
        return new Response("{}", { status: state.installed ? 200 : 503 });
      expect(String(input)).toBe(
        "https://raw.githubusercontent.com/onecli/onecli/v1.42.0/docker/docker-compose.yml",
      );
      return new Response(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Literal Docker Compose substitutions.
        "services:\n  onecli:\n    image: ghcr.io/onecli/onecli:${ONECLI_VERSION:-latest}\n    env_file:\n      - path: ../.env\n        required: false\n",
      );
    },
    async exec(command, args) {
      expect(command).toBe("docker");
      commands.push(args);
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const failed = { code: 1, stdout: "", stderr: "fixture failure" };
      if (args[0] === "compose") {
        const compose = await readFile(args[args.indexOf("-f") + 1], "utf8");
        expect(compose).toContain("ghcr.io/onecli/onecli:1.42.0");
        expect(compose).not.toContain("env_file");
        state.installed = true;
      } else if (args[0] === "network" && args[1] === "inspect") return ok("true");
      else if (args[0] === "inspect" && args[1] === "onecli") {
        const networks = {
          backend: { IPAddress: "172.20.0.2" },
          ...(state.connected
            ? { "mybots-isolated": { IPAddress: "172.21.0.2", Aliases: [state.alias] } }
            : {}),
        };
        return ok(
          JSON.stringify(
            args.at(-1) === "{{json .}}"
              ? { State: { Running: true }, NetworkSettings: { Networks: networks } }
              : networks,
          ),
        );
      } else if (args[0] === "inspect" && args[1] === name) {
        if (!state.relay) return failed;
        return ok(
          JSON.stringify({
            Config: {
              Image: state.foreignRelay ? "unrelated" : "alpine/socat",
              Cmd: ["TCP-LISTEN:10255,fork,reuseaddr", "TCP:172.20.0.2:10255"],
            },
            NetworkSettings: {
              Networks: { "mybots-isolated": { Aliases: ["onecli"] }, backend: {} },
            },
          }),
        );
      } else if (args[0] === "network" && args[1] === "connect") {
        if (state.connectFailure) return failed;
        if (args.at(-1) === "onecli") {
          state.connected = true;
          state.alias = args[3];
        } else if (args.at(-1) === name) state.relayAttached = true;
      } else if (args[0] === "network" && args[1] === "disconnect") {
        if (args.at(-1) === "onecli") state.connected = false;
        else if (args.at(-1) === name) state.relayAttached = false;
      } else if (args[0] === "run") {
        expect(args).toContain("--rm");
        if (args.at(-1) === state.probeFailure) return failed;
      } else if (args[0] === "rm") {
        expect(args).toEqual(["rm", "-f", name]);
        state.relay = false;
      } else throw new Error(`Unexpected Docker command: ${args.join(" ")}`);
      return ok();
    },
  };
  return { ctx, state, commands, name };
}

it("bootstraps the pinned gateway and repairs direct OneCLI attachment on rerun", async () => {
  const { ctx, state, commands } = await fixture();
  await runSetupStep("gateway", ctx);
  expect(state).toMatchObject({ installed: true, connected: true, relay: false });
  expect(commands).toContainEqual([
    "network",
    "connect",
    "--alias",
    "onecli",
    "mybots-isolated",
    "onecli",
  ]);
  expect(await readFile(join(ctx.root, ".env"), "utf8")).toContain(
    "ONECLI_URL=http://127.0.0.1:10254",
  );
  state.connected = false;
  await runSetupStep("gateway", ctx);
  expect(state.connected).toBe(true);
  state.alias = "stale-alias";
  await runSetupStep("gateway", ctx);
  expect(state.alias).toBe("onecli");
  expect(commands.filter((args) => args[0] === "compose")).toHaveLength(1);
});

it("retains the current relay until both direct IP and alias access have passed", async () => {
  const { ctx, state, commands, name } = await fixture();
  state.relay = true;
  state.probeFailure = "172.21.0.2";
  await expect(runSetupStep("gateway", ctx)).rejects.toThrow();
  expect(state.relay && state.relayAttached).toBe(true);
  expect(state.connected).toBe(false);
  state.probeFailure = "onecli";
  await expect(runSetupStep("gateway", ctx)).rejects.toThrow();
  expect(state.relay && state.relayAttached).toBe(true);
  state.probeFailure = "";
  await runSetupStep("gateway", ctx);
  expect(state.relay).toBe(false);
  expect(commands.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", name]]);
});

it("does not remove an unrelated container or a relay after attachment failure", async () => {
  const { ctx, state } = await fixture();
  state.relay = true;
  state.connectFailure = true;
  await expect(runSetupStep("gateway", ctx)).rejects.toThrow(
    "Direct OneCLI network attachment failed",
  );
  expect(state.relay).toBe(true);
  state.connectFailure = false;
  state.foreignRelay = true;
  await expect(runSetupStep("gateway", ctx)).rejects.toThrow("refusing to remove");
  expect(state.relay && state.relayAttached).toBe(true);
});
