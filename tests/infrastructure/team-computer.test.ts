import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DockerSandbox } from "@mybots/sandbox";
import { expect, test } from "vitest";

const docker = promisify(execFile);

async function computerFixture() {
  const root = await mkdtemp(join(tmpdir(), "mybots-computer-"));
  const computer = { id: `mybots-${randomUUID()}` };
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  return {
    root,
    computer,
    workspace,
    provider: new DockerSandbox(computer, workspace),
    async close(): Promise<void> {
      try {
        await docker("docker", ["rm", "-f", computer.id]);
      } catch (error) {
        if (!String(error).includes("No such container")) throw error;
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
}

test("shell and file operations share bytes on one Computer during simultaneous first use", async () => {
  const fixture = await computerFixture();
  const { provider, computer } = fixture;
  try {
    await Promise.all([
      provider.writeFile(computer, "bots/writer/tool.txt", "from file tool\n"),
      provider.execute(computer, "printf 'from shell\\r\\n' > shell.txt", "bots/reader"),
    ]);
    expect(await provider.readFile(computer, "bots/reader/shell.txt")).toBe("from shell\r\n");
    expect(
      (await provider.execute(computer, "cat /workspace/bots/writer/tool.txt", "shared")).stdout,
    ).toBe("from file tool\n");
    expect(
      (
        await provider.execute(
          computer,
          "find /tmp/mybots-commands -mindepth 1 -maxdepth 1 -type d | wc -l",
          "shared",
        )
      ).stdout.trim(),
    ).toBe("1");
  } finally {
    await fixture.close();
  }
});

test("a new provider reattaches working files after actual container replacement", async () => {
  const fixture = await computerFixture();
  try {
    await fixture.provider.writeFile(fixture.computer, "shared/keep.txt", "persistent bytes");
    const reopened = new DockerSandbox(fixture.computer, fixture.workspace);
    expect(await reopened.readFile(fixture.computer, "shared/keep.txt")).toBe("persistent bytes");
    await docker("docker", ["rm", "-f", fixture.computer.id]);
    const replacement = new DockerSandbox(fixture.computer, fixture.workspace);
    expect(await replacement.readFile(fixture.computer, "shared/keep.txt")).toBe(
      "persistent bytes",
    );
  } finally {
    await fixture.close();
  }
});

test("workspace export/import round trips binary, text, directories and executable permissions", async () => {
  const source = await computerFixture();
  const target = await computerFixture();
  try {
    await source.provider.execute(
      source.computer,
      "mkdir -p shared/empty; printf '#!/bin/sh\\necho restored\\n' > run.sh; chmod 755 run.sh; python3 -c 'from pathlib import Path; Path(\"shared/bytes.bin\").write_bytes(bytes(range(256)))'",
      "bots/writer",
    );
    const archive = await source.provider.exportWorkspace(source.computer);
    await target.provider.importWorkspace(target.computer, archive);
    const result = await target.provider.execute(
      target.computer,
      './run.sh; python3 -c \'from pathlib import Path; print(Path("shared/bytes.bin").read_bytes() == bytes(range(256))); print(Path("shared/empty").is_dir())\'',
      "bots/writer",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("restored\nTrue\nTrue\n");
  } finally {
    await Promise.all([source.close(), target.close()]);
  }
});

test("cancellation kills the container process group while another command remains usable", async () => {
  const fixture = await computerFixture();
  const { provider, computer } = fixture;
  const controller = new AbortController();
  let command: Promise<unknown> | undefined;
  let other: Promise<unknown> | undefined;
  try {
    command = provider.execute(
      computer,
      'sleep 120 & echo "$$ $!" > pids; while :; do date +%s > heartbeat; sleep 0.05; done',
      "bots/busy",
      controller.signal,
    );
    // Attach rejection handling before signalling cancellation.
    const cancelled = expect(command).rejects.toThrow();
    await expect
      .poll(
        async () => {
          try {
            return await provider.readFile(computer, "bots/busy/pids");
          } catch {
            return "";
          }
        },
        { timeout: 10000 },
      )
      .not.toBe("");
    other = provider.execute(
      computer,
      'touch ready; until [ -f release ]; do sleep 0.05; done; echo "other Bot finished"',
      "bots/other",
    );
    await expect
      .poll(
        async () => {
          try {
            await provider.readFile(computer, "bots/other/ready");
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
    controller.abort();
    await cancelled;
    const check = await provider.execute(
      computer,
      `python3 -c 'from pathlib import Path; ids=Path("pids").read_text().split(); print(any(Path("/proc", pid, "stat").exists() and Path("/proc", pid, "stat").read_text().split()[2] != "Z" for pid in ids))'`,
      "bots/busy",
    );
    expect(check.stdout).toBe("False\n");
    await provider.writeFile(computer, "bots/other/release", "go");
    expect(await other).toMatchObject({ exitCode: 0, stdout: "other Bot finished\n" });
    expect(
      (
        await provider.execute(
          computer,
          "find /tmp/mybots-commands -mindepth 1 -maxdepth 1 -type d | wc -l",
          "shared",
        )
      ).stdout.trim(),
    ).toBe("1");
    expect(await provider.readFile(computer, "bots/busy/heartbeat")).toMatch(/^\d+\n$/);
  } finally {
    controller.abort();
    await fixture.close();
    await Promise.allSettled([command, other]);
  }
});

test("real SDK chat uses Computer tools and retains working files after application and container replacement", async () => {
  const { apiFixture } = await import("../durable-api-fixture.ts");
  const { ProductDatabase } = await import("@mybots/db");
  const replies: import("../durable-model-fixture.ts").ModelReply[] = [
    { tool: "shell", arguments: { command: "printf 'shell evidence' > note.txt" } },
    { tool: "read_file", arguments: { path: "note.txt" } },
    { tool: "write_file", arguments: { path: "shared/generated.txt", content: "tool evidence" } },
    { tool: "shell", arguments: { command: "cat generated.txt", cwd: "/shared" } },
    { text: "Both tools used the same files" },
  ];
  const fixture = await apiFixture(() => {
    const reply = replies.shift();
    if (!reply) throw new Error("Unexpected model request");
    return reply;
  });
  const products = new ProductDatabase(join(fixture.root, "product.sqlite"));
  const computer = products.computer();
  products.close();
  try {
    const bot = await fixture.request("bots", {
      name: "Tool user",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Use the Computer", requestId: "tools" });
    let view: import("@mybots/contracts").ChatView | undefined;
    const settled = async () => {
      await expect
        .poll(
          async () => {
            view = await fixture.request(`bots/${bot.id}/chat`);
            return view?.busy;
          },
          { timeout: 15000 },
        )
        .toBe(false);
      return view;
    };
    await settled();
    expect(view?.messages.at(-1)?.text).toBe("Both tools used the same files");
    expect(
      view?.messages.filter((message) => message.role === "tool").map((message) => message.text),
    ).toContain("shell evidence");
    expect(JSON.stringify(fixture.service.requests)).toContain("tool evidence");
    expect(view?.messages.flatMap((message) => message.tools)).toEqual([
      "shell",
      "read_file",
      "write_file",
      "shell",
    ]);
    await fixture.reopen();
    expect((await settled())?.messages.at(-1)?.text).toBe("Both tools used the same files");
    await docker("docker", ["rm", "-f", computer.id]);
    await fixture.reopen();
    replies.push(
      {
        tool: "shell",
        arguments: {
          command:
            'cat note.txt; cat /workspace/shared/generated.txt; python3 -c \'import os; from pathlib import Path; assert "fixture-key" not in str(os.environ); assert not Path("/workspace/models.json").exists()\'',
        },
      },
      { text: "Working files survived" },
    );
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Read after replacement",
      requestId: "reopened",
    });
    await settled();
    expect(view?.messages.at(-1)?.text).toBe("Working files survived");
    const result = JSON.parse(
      view?.messages.filter((message) => message.role === "tool").at(-1)?.text ?? "{}",
    );
    expect(result).toMatchObject({ exitCode: 0, stdout: "shell evidencetool evidence" });
  } finally {
    try {
      await fixture.close();
    } finally {
      await docker("docker", ["rm", "-f", computer.id]).catch((error) => {
        if (!String(error).includes("No such container")) throw error;
      });
    }
  }
});

test("provider rejects escaped paths, outside symlinks and unsafe archives without extracting earlier members", async () => {
  const fixture = await computerFixture();
  const { provider, computer } = fixture;
  try {
    await expect(provider.writeFile(computer, "../escape", "no")).rejects.toThrow(
      "workspace-relative",
    );
    await provider.execute(computer, "ln -s /etc outside", "shared");
    await expect(provider.readFile(computer, "shared/outside/passwd")).rejects.toThrow("escapes");
    await expect(provider.writeFile(computer, "shared/outside/test", "no")).rejects.toThrow(
      "escapes",
    );
    await expect(provider.exportWorkspace(computer)).rejects.toThrow("regular files");
    const result = await provider.execute(
      computer,
      `python3 - <<'PY'
import base64, io, tarfile
buffer = io.BytesIO()
with tarfile.open(fileobj=buffer, mode="w") as archive:
    good = tarfile.TarInfo("shared/should-not-write")
    good.size = 3
    archive.addfile(good, io.BytesIO(b"bad"))
    bad = tarfile.TarInfo("../escape")
    bad.size = 3
    archive.addfile(bad, io.BytesIO(b"bad"))
print(base64.b64encode(buffer.getvalue()).decode())
PY`,
      "shared",
    );
    await expect(
      provider.importWorkspace(computer, Buffer.from(result.stdout.trim(), "base64")),
    ).rejects.toThrow("workspace-relative");
    expect(
      (await provider.execute(computer, "test ! -e should-not-write", "shared")).exitCode,
    ).toBe(0);
    await expect(
      provider.importWorkspace(computer, new Uint8Array(16 * 1024 * 1024 + 1)),
    ).rejects.toThrow("16 MiB");
  } finally {
    await fixture.close();
  }
});

test("public Stop cancels an active SDK shell tool and publishes the interrupted result", async () => {
  const { apiFixture } = await import("../durable-api-fixture.ts");
  const { ProductDatabase } = await import("@mybots/db");
  const fixture = await apiFixture(() => ({
    tool: "shell",
    arguments: { command: 'echo "$$" > pid; while :; do sleep 1; done' },
  }));
  const database = new ProductDatabase(join(fixture.root, "product.sqlite"));
  const computer = database.computer();
  database.close();
  const provider = new DockerSandbox(computer, join(fixture.root, "computer", "workspace"));
  try {
    const bot = await fixture.request("bots", {
      name: "Busy",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Long work", requestId: "stop-command" });
    await expect
      .poll(
        async () => {
          const view = await fixture.request(`bots/${bot.id}/chat`);
          return view.activity;
        },
        { timeout: 10000 },
      )
      .toContain("shell");
    await expect
      .poll(
        async () => {
          try {
            return await provider.readFile(computer, `bots/${bot.id}/pid`);
          } catch {
            return "";
          }
        },
        { timeout: 10000 },
      )
      .not.toBe("");
    await fixture.request(`bots/${bot.id}/stop`, {});
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 5000 })
      .toBe(false);
    const check = await provider.execute(
      computer,
      `python3 -c 'from pathlib import Path; pid=Path("pid").read_text().strip(); print(Path("/proc",pid).exists())'`,
      `bots/${bot.id}`,
    );
    expect(check.stdout).toBe("False\n");
    const view = await fixture.request(`bots/${bot.id}/chat`);
    expect(
      view.messages.filter((message: { role: string }) => message.role === "tool").at(-1)?.text,
    ).toMatch(/abort|interrupt|cancel/i);
  } finally {
    try {
      await fixture.close();
    } finally {
      await docker("docker", ["rm", "-f", computer.id]).catch((error) => {
        if (!String(error).includes("No such container")) throw error;
      });
    }
  }
});

async function chatComputerFixture(
  respond: Parameters<typeof import("../durable-api-fixture.ts").apiFixture>[0],
  options?: Parameters<typeof import("../durable-api-fixture.ts").apiFixture>[1],
) {
  const { apiFixture } = await import("../durable-api-fixture.ts");
  const { ProductDatabase } = await import("@mybots/db");
  const fixture = await apiFixture(respond, options);
  const database = new ProductDatabase(join(fixture.root, "product.sqlite"));
  const computer = database.computer();
  database.close();
  return {
    ...fixture,
    get url() {
      return fixture.url;
    },
    computer,
    provider: new DockerSandbox(computer, join(fixture.root, "computer", "workspace")),
    async close(): Promise<void> {
      try {
        await fixture.close();
      } finally {
        await docker("docker", ["rm", "-f", computer.id]).catch((error) => {
          if (!String(error).includes("No such container")) throw error;
        });
      }
    },
  };
}

test("built Web steers at a real tool boundary and stops only the selected Bot's Docker work", async () => {
  const { chromium } = await import("@playwright/test");
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let alphaCalls = 0;
  const fixture = await chatComputerFixture((request) => {
    if (JSON.stringify(request.messages).includes("ALPHA_BOT")) {
      alphaCalls++;
      if (alphaCalls === 1)
        return {
          tool: "shell",
          arguments: {
            command:
              "printf 'started\\n' >> effects; echo $$ > pid; while [ ! -f release ]; do sleep 0.05; done; printf 'finished\\n' >> effects",
          },
        };
      return {
        tool: "shell",
        arguments: { command: "echo $$ > stop-pid; while :; do sleep 1; done" },
      };
    }
    if (request.messages.some((message) => message.role === "tool"))
      return { text: "Beta finished independently" };
    return {
      tool: "shell",
      arguments: {
        command:
          "echo $$ > pid; while [ ! -f release ]; do sleep 0.05; done; printf 'beta complete' > result",
      },
    };
  });
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await fixture.provider.prepare(fixture.computer);
    const alpha = await fixture.request("bots", {
      name: "Alpha",
      instructions: "ALPHA_BOT",
      model: "deepseek/deepseek-flash",
    });
    const beta = await fixture.request("bots", {
      name: "Beta",
      instructions: "BETA_BOT",
      model: "deepseek/deepseek-flash",
    });
    await page.goto(fixture.url);
    await page.getByLabel("Connection credential").fill(fixture.credential);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("button", { name: "Select Alpha", exact: true }).click();
    const send = async (text: string) => {
      await page.getByLabel("Message", { exact: true }).fill(text);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => page.getByLabel("Message", { exact: true }).inputValue()).toBe("");
    };
    const file = (bot: { id: string }, name: string) =>
      fixture.provider.readFile(fixture.computer, `bots/${bot.id}/${name}`).catch(() => "");
    await send("Alpha work");
    await expect.poll(() => file(alpha, "pid"), { timeout: 15000 }).not.toBe("");
    await fixture.request(`bots/${beta.id}/send`, { text: "Beta work", requestId: "beta-work" });
    await expect.poll(() => file(beta, "pid"), { timeout: 15000 }).not.toBe("");
    await send("Alpha steering");
    await expect
      .poll(() => page.locator("#unprocessed").textContent())
      .toContain("Queued for steering");
    expect(alphaCalls).toBe(1);
    expect(await file(alpha, "effects")).toBe("started\n");
    await page.context().setOffline(true);
    await page.context().setOffline(false);
    await page.reload();
    await expect.poll(() => page.locator("#unprocessed").textContent()).toContain("Alpha steering");
    await fixture.provider.writeFile(fixture.computer, `bots/${alpha.id}/release`, "go");
    await expect.poll(() => file(alpha, "stop-pid"), { timeout: 15000 }).not.toBe("");
    const steered = fixture.service.requests.find((request) =>
      JSON.stringify(request.messages).includes("Alpha steering"),
    );
    expect(steered?.messages).toContainEqual(expect.objectContaining({ role: "tool" }));
    expect(await file(alpha, "effects")).toBe("started\nfinished\n");
    await send("Withdraw this input");
    await expect
      .poll(() => page.locator("#unprocessed").textContent())
      .toContain("Queued for steering");
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    await expect
      .poll(async () => (await fixture.request(`bots/${alpha.id}/chat`)).busy)
      .toBe(false);
    const processState = await fixture.provider.execute(
      fixture.computer,
      `python3 -c 'from pathlib import Path; a=Path("/proc",Path("bots/${alpha.id}/stop-pid").read_text().strip()); b=Path("/proc",Path("bots/${beta.id}/pid").read_text().strip()); print(a.exists(),b.exists())'`,
      "",
    );
    expect(processState.stdout).toBe("False True\n");
    expect((await fixture.request(`bots/${beta.id}/chat`)).busy).toBe(true);
    await page.reload();
    await expect
      .poll(() => page.locator("article.tool").allTextContents())
      .toContainEqual(expect.stringMatching(/abort|interrupt/i));
    const withdrawn = page
      .locator("#unprocessed article")
      .filter({ hasText: "Withdraw this input" });
    await expect.poll(() => withdrawn.textContent()).toContain("Unprocessed");
    await withdrawn.getByRole("button", { name: "Resend", exact: true }).click();
    expect(await page.getByLabel("Message", { exact: true }).inputValue()).toBe(
      "Withdraw this input",
    );
    await page.screenshot({ path: "/tmp/mybots-control-docker-browser.png", fullPage: true });
    await fixture.provider.writeFile(fixture.computer, `bots/${beta.id}/release`, "go");
    await expect
      .poll(async () => (await fixture.request(`bots/${beta.id}/chat`)).busy, { timeout: 15000 })
      .toBe(false);
    expect(await file(beta, "result")).toBe("beta complete");
    await page.getByRole("button", { name: "Select Beta", exact: true }).click();
    await expect
      .poll(() => page.locator("#thread-messages").textContent())
      .toContain("Beta finished independently");
    expect(errors).toEqual([]);
  } finally {
    try {
      await browser?.close();
    } finally {
      await fixture.close();
    }
  }
});

test("worker crash records an unsafe shell as interrupted without reexecuting its file effects", async () => {
  let calls = 0;
  const fixture = await chatComputerFixture(() =>
    ++calls === 1
      ? {
          tool: "shell",
          arguments: {
            command:
              "printf 'once\\n' >> effects; echo $$ > pid; while [ ! -f release ]; do sleep 0.05; done; printf done > finished",
          },
        }
      : { text: "The interrupted command may have changed files" },
  );
  try {
    await fixture.provider.prepare(fixture.computer);
    const bot = await fixture.request("bots", {
      name: "Interrupted",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    const admitted = await fixture.request(`bots/${bot.id}/send`, {
      text: "Unsafe work",
      requestId: "unsafe-work",
    });
    await expect
      .poll(
        async () => {
          const view = await fixture.request(`bots/${bot.id}/chat`);
          if (!view.busy) throw new Error(JSON.stringify(view));
          return fixture.provider.readFile(fixture.computer, `bots/${bot.id}/pid`).catch(() => "");
        },
        { timeout: 15000 },
      )
      .not.toBe("");
    await fixture.crashWorker();
    // A killed host cannot promise to cancel Docker effects; let this owned fixture command finish.
    await fixture.provider.writeFile(fixture.computer, `bots/${bot.id}/release`, "go");
    await expect
      .poll(
        async () =>
          fixture.provider.readFile(fixture.computer, `bots/${bot.id}/finished`).catch(() => ""),
        { timeout: 10000 },
      )
      .toBe("done");
    await fixture.reopen();
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 10000 })
      .toBe(false);
    const view = await fixture.request(`bots/${bot.id}/chat`);
    expect(
      view.messages.filter((message: { role: string }) => message.role === "tool").at(-1)?.text,
    ).toMatch(/interrupted.*partially run/i);
    expect(view.messages.at(-1)?.text).toBe("The interrupted command may have changed files");
    expect(await fixture.provider.readFile(fixture.computer, `bots/${bot.id}/effects`)).toBe(
      "once\n",
    );
    expect(
      await fixture.request(`bots/${bot.id}/send`, {
        text: "Unsafe work",
        requestId: "unsafe-work",
      }),
    ).toEqual(admitted);
    expect(calls).toBe(2);
  } finally {
    await fixture.close();
  }
});

test("resources, compacted originals and shared Computer compose across restart and Bots", async () => {
  const original = `COMBINED_ORIGINAL ${"archived fact ".repeat(1800)}ORIGINAL_END`;
  const replies: import("../durable-model-fixture.ts").ModelReply[] = [];
  let summaries = 0;
  const fixture = await chatComputerFixture(
    (request) => {
      if (JSON.stringify(request.messages[0]).includes("summarization")) {
        summaries++;
        return { text: "Native summary of completed work." };
      }
      return replies.shift() ?? { text: "Unexpected generation" };
    },
    { contextWindow: 5000 },
  );
  try {
    const alpha = await fixture.request("bots", {
      name: "Writer",
      instructions: "WRITER_ROLE",
      model: "deepseek/deepseek-flash",
    });
    const beta = await fixture.request("bots", {
      name: "Reader",
      instructions: "READER_ROLE",
      model: "deepseek/deepseek-flash",
    });
    async function send(
      botId: string,
      text: string,
    ): Promise<import("@mybots/contracts").ChatView> {
      await fixture.request(`bots/${botId}/send`, { text, requestId: randomUUID() });
      await expect
        .poll(async () => (await fixture.request(`bots/${botId}/chat`)).busy, { timeout: 20000 })
        .toBe(false);
      return fixture.request(`bots/${botId}/chat`);
    }
    replies.push({ text: original });
    const archived = await send(alpha.id, "Keep this original source");
    const originalId = Number(archived.messages.at(-1)?.id);
    for (let index = 0; index < 5; index++) {
      replies.push({ text: "Recent answer" });
      await send(alpha.id, `recent-${index}`);
    }
    expect(summaries).toBeGreaterThan(0);
    await fixture.request(
      "skills/combine",
      {
        description: "Use earlier evidence with shared files",
        content: "FULL_COMBINED_SKILL",
      },
      "PUT",
    );
    await fixture.request("memory/owner", { content: "SHARED_OWNER_PREFERENCE" }, "PUT");
    await fixture.request(`bots/${alpha.id}/memory`, { content: "WRITER_PRIVATE_MEMORY" }, "PUT");
    await fixture.request(`bots/${beta.id}/memory`, { content: "READER_PRIVATE_MEMORY" }, "PUT");
    await fixture.reopen();
    expect((await fixture.request("bots")).bots).toEqual([alpha, beta]);
    const start = fixture.service.requests.length;
    replies.push(
      { tool: "skill_read", arguments: { name: "combine" } },
      { tool: "history_read", arguments: { entryId: originalId } },
      {
        tool: "write_file",
        arguments: { path: "shared/evidence.txt", content: "COMBINED_ORIGINAL" },
      },
      { tool: "shell", arguments: { cwd: "/shared", command: "cat evidence.txt" } },
      { text: "Original evidence is now shared" },
    );
    const completed = await send(
      alpha.id,
      "Use the Skill and retrieve original evidence into a shared file",
    );
    expect(completed.messages.at(-1)?.text).toBe("Original evidence is now shared");
    const generations = fixture.service.requests
      .slice(start)
      .filter((request) => !JSON.stringify(request.messages[0]).includes("summarization"));
    const initial = JSON.stringify(generations[0]);
    expect(initial).toContain("SHARED_OWNER_PREFERENCE");
    expect(initial).toContain("WRITER_PRIVATE_MEMORY");
    expect(initial).toContain("Use earlier evidence with shared files");
    expect(initial).not.toContain("FULL_COMBINED_SKILL");
    expect(initial).not.toContain("COMBINED_ORIGINAL");
    expect(initial).not.toContain("recent-0");
    expect(JSON.stringify(generations)).not.toContain("READER_PRIVATE_MEMORY");
    expect(JSON.stringify(generations)).toContain("FULL_COMBINED_SKILL");
    expect(JSON.stringify(generations)).toContain("Historical evidence");
    expect(completed.messages.filter((message) => message.role === "tool").at(-1)?.text).toContain(
      '"stdout":"COMBINED_ORIGINAL"',
    );
    for (const request of generations) {
      expect(
        request.messages
          .filter((message) => message.role === "tool")
          .map((message) => message.tool_call_id),
      ).toEqual(
        request.messages.flatMap((message) => message.tool_calls?.map((call) => call.id) ?? []),
      );
    }
    await fixture.reopen();
    await docker("docker", ["rm", "-f", fixture.computer.id]);
    const otherStart = fixture.service.requests.length;
    replies.push(
      { tool: "read_file", arguments: { path: "shared/evidence.txt" } },
      { text: "Reader used the retained file" },
    );
    const read = await send(beta.id, "Read the shared evidence");
    expect(read.messages.at(-1)?.text).toBe("Reader used the retained file");
    expect(read.messages.find((message) => message.role === "tool")?.text).toBe(
      "COMBINED_ORIGINAL",
    );
    const otherContext = JSON.stringify(fixture.service.requests.slice(otherStart));
    expect(otherContext).toContain("SHARED_OWNER_PREFERENCE");
    expect(otherContext).toContain("READER_PRIVATE_MEMORY");
    expect(otherContext).not.toContain("WRITER_PRIVATE_MEMORY");
    expect((await fixture.request(`bots/${alpha.id}/history/${originalId}`)).text).toContain(
      "COMBINED_ORIGINAL",
    );
    expect(replies).toHaveLength(0);
  } finally {
    await fixture.close();
  }
});
