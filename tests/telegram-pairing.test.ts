import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TelegramChannel } from "../packages/host/src/channels/telegram.ts";
import type { TelegramApi } from "../packages/host/src/channels/telegram-api.ts";
import {
  completePairing,
  createPairingCode,
  readPairingState,
  writePairingState,
} from "../packages/host/src/channels/telegram-pairing.ts";
import { readPairedTelegram } from "../packages/host/src/db/index.ts";
import { Host, type HostConfiguration } from "../packages/host/src/host.ts";
import { MailboxDriver } from "./host-fixture.ts";

const configuration: HostConfiguration = {
  owners: ["cli:local"],
  agent: {
    id: "personal",
    name: "Personal",
    folder: "personal",
    model: {
      provider: "deepseek",
      id: "deepseek-chat",
      baseUrl: "https://api.deepseek.com",
      contextWindow: 128000,
      maxTokens: 4096,
    },
  },
  destinations: [{ id: "terminal", channelType: "cli", platformId: "local", instance: "cli" }],
};

let root: string;
let host: Host | undefined;
let channel: TelegramChannel | undefined;

afterEach(async () => {
  await channel?.stop();
  channel = undefined;
  await host?.stop();
  host = undefined;
  if (root) await rm(root, { recursive: true, force: true });
});

it("registers the private chat that sends the pairing code and leaves the message out of the Agent", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-pair-")));
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await writePairingState(root, { code: "123456", wrongs: 0 });
  const sends: string[] = [];
  const api: TelegramApi = {
    async getMe() {
      return { id: "1", topicsEnabled: false };
    },
    async getUpdates(offset) {
      return { updates: [], nextOffset: offset };
    },
    async getChat() {
      return { isForum: false };
    },
    async createForumTopic() {
      return { topicId: "1" };
    },
    async sendMessage(_chatId, text) {
      sends.push(text);
    },
  };
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations: [],
    owners: configuration.owners,
    pairingRoot: root,
    registerOwner: (platformId) => host?.registerTelegramOwner(platformId),
  });
  const accepted = await channel.dispatch({
    updateId: 1,
    userId: "42",
    chatId: "42",
    text: "1 2 3 4 5 6",
  });
  expect(accepted).toBeUndefined();
  expect(sends).toEqual(["Pairing success!"]);
  expect(host.sessions()).toEqual([]);
  expect(await readPairingState(root)).toMatchObject({ pairedOwner: "42" });
  await channel.dispatch({ updateId: 2, userId: "99", chatId: "99", text: "123456" });
  expect(readPairedTelegram(root)?.platformId).toBe("42");
  expect(readPairedTelegram(root)).toEqual({ platformId: "42", instance: "telegram" });
  await channel.dispatch({
    updateId: 3,
    userId: "43",
    chatId: "43",
    text: "123456",
    threadId: "9",
  });
  await channel.dispatch({ updateId: 4, userId: "42", chatId: "42", text: "Hello" });
  expect(host.sessions()).toEqual([]);
});

it("retires a wrong pairing code and ignores groups and unpaired private chats", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-pair-")));
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await writePairingState(root, { code: "123456", wrongs: 0 });
  const api: TelegramApi = {
    async getMe() {
      return { id: "1", topicsEnabled: false };
    },
    async getUpdates(offset) {
      return { updates: [], nextOffset: offset };
    },
    async getChat() {
      return { isForum: false };
    },
    async createForumTopic() {
      return { topicId: "1" };
    },
    async sendMessage() {},
  };
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations: [],
    owners: configuration.owners,
    pairingRoot: root,
    registerOwner: (platformId) => host?.registerTelegramOwner(platformId),
  });
  await channel.dispatch({ updateId: 1, userId: "7", chatId: "-100", text: "123456" });
  expect(await readPairingState(root)).toEqual({ code: "123456", wrongs: 0 });
  await channel.dispatch({ updateId: 2, userId: "7", chatId: "7", text: "nope" });
  const replaced = await readPairingState(root);
  expect(replaced?.wrongs).toBe(1);
  expect(replaced?.code).toMatch(/^\d{6}$/u);
  expect(readPairedTelegram(root)).toBeUndefined();
  expect(host.sessions()).toEqual([]);
  await completePairing(root);
  await channel.dispatch({ updateId: 3, userId: "7", chatId: "7", text: "hello" });
  expect(host.sessions()).toEqual([]);
  expect(createPairingCode()).toMatch(/^\d{6}$/u);
});

it("drops the pairing state on the sixth wrong private message", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-pair-")));
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  await writePairingState(root, { code: "123456", wrongs: 5 });
  const api: TelegramApi = {
    async getMe() {
      return { id: "1", topicsEnabled: false };
    },
    async getUpdates(offset) {
      return { updates: [], nextOffset: offset };
    },
    async getChat() {
      return { isForum: false };
    },
    async createForumTopic() {
      return { topicId: "1" };
    },
    async sendMessage() {},
  };
  channel = TelegramChannel.listen({
    host,
    api,
    instance: "telegram",
    destinations: [],
    owners: configuration.owners,
    pairingRoot: root,
  });
  await channel.dispatch({ updateId: 1, userId: "7", chatId: "7", text: "wrong" });
  expect(await readPairingState(root)).toBeUndefined();
  expect(readPairedTelegram(root)).toBeUndefined();
});

it("merges a paired owner on the next host start", async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "mybots-pair-")));
  host = await Host.start({ root, configuration, driver: new MailboxDriver() });
  host.registerTelegramOwner("42");
  await host.stop();
  host = undefined;
  const { loadHostSettings } = await import("../packages/host/src/config/host.ts");
  const { mergePairedTelegram } = await import("../packages/host/src/config/operator-env.ts");
  await writeFile(
    join(root, "host.json"),
    JSON.stringify({
      ...configuration,
      cliDestinationId: "terminal",
      container: { image: "mybots-agent:mailbox", network: "mybots-isolated" },
      gateway: { url: "http://127.0.0.1:10254", proxyHost: "onecli" },
      telegram: { instance: "telegram" },
    }),
  );
  const settings = await loadHostSettings(join(root, "host.json"));
  const paired = readPairedTelegram(root);
  expect(paired).toEqual({ platformId: "42", instance: "telegram" });
  expect(
    mergePairedTelegram(
      settings.configuration,
      settings.telegram?.instance ?? "",
      paired?.platformId ?? "",
    ),
  ).toMatchObject({
    owners: ["cli:local", "telegram:42"],
    destinations: [
      { id: "terminal", channelType: "cli", platformId: "local", instance: "cli" },
      { id: "owner-chat", channelType: "telegram", platformId: "42", instance: "telegram" },
    ],
  });
});
