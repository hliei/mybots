import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { DockerSandbox } from "@mybots/sandbox";
import { expect, test } from "vitest";

const docker = promisify(execFile);

test("bounded commands publish output before exit and preserve the final error", async () => {
  const fixture = await computerFixture();
  const { provider, computer } = fixture;
  let command: Promise<unknown> | undefined;
  try {
    const chunks: string[] = [];
    command = provider.execute(
      computer,
      "printf 'sign-in code'; until [ -f release ]; do sleep 0.05; done; printf 'failed' >&2; exit 7",
      "shared",
      undefined,
      { onOutput: (text: string) => chunks.push(text) },
    );
    void command.catch(() => {});
    await expect.poll(() => chunks.join(""), { timeout: 10000 }).toContain("sign-in code");
    await provider.writeFile(computer, "shared/release", "go");
    expect(await command).toMatchObject({ exitCode: 7, stderr: "failed" });
  } finally {
    await fixture.close();
    await Promise.allSettled([command]);
  }
});

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
    await expect
      .poll(() => fixture.request("worker"), { timeout: 15000 })
      .toEqual({ state: "recovered" });
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
    expect(
      JSON.parse(
        completed.messages.filter((message) => message.role === "tool").at(-1)?.text ?? "{}",
      ),
    ).toMatchObject({ stdout: "COMBINED_ORIGINAL" });
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

test("real SDK receives a running command then continues with its actual exit without replay", async () => {
  let calls = 0;
  const fixture = await chatComputerFixture(() => {
    calls++;
    if (calls === 1)
      return {
        tool: "shell",
        arguments: {
          command:
            "printf 'one-time code: 1234'; until [ -f release ]; do sleep 0.05; done; echo final-error >&2; exit 7",
        },
      };
    if (calls === 2) return { tool: "write_file", arguments: { path: "release", content: "go" } };
    if (calls === 3) return { text: "I saw the code; checking completion." };
    return { text: "Command finished with exit 7" };
  });
  try {
    const bot = await fixture.request("bots", {
      name: "Progress",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Run the command",
      requestId: "progress",
    });
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 20000 })
      .toBe(false);
    const view = await fixture.request(`bots/${bot.id}/chat`);
    expect(view.messages.at(-1)?.text).toBe("Command finished with exit 7");
    const early = fixture.service.requests[1]?.messages.find((message) => message.role === "tool");
    expect(JSON.parse(String(early?.content))).toMatchObject({
      running: true,
      exitCode: null,
      stdout: "one-time code: 1234",
      service: false,
    });
    expect(JSON.stringify(fixture.service.requests.at(-1))).toContain("final-error");
    expect(JSON.stringify(fixture.service.requests.at(-1))).toContain('\\"exitCode\\": 7');
    expect(
      view.messages
        .flatMap((message: { tools: string[] }) => message.tools)
        .filter((name: string) => name === "shell"),
    ).toHaveLength(1);
    expect(view.inputs).toEqual([]);
  } finally {
    await fixture.close();
  }
});

function serviceCommand(port: number): string {
  return `python3 -u -m http.server ${port} --bind 127.0.0.1`;
}

async function serviceAnswers(
  fixture: Awaited<ReturnType<typeof chatComputerFixture>>,
  port: number,
): Promise<boolean> {
  const result = await fixture.provider.execute(
    fixture.computer,
    `curl -fsS --max-time 1 http://127.0.0.1:${port}/ > /dev/null`,
    "shared",
  );
  return result.exitCode === 0;
}

test("public Stop kills this turn's service and command while retaining prior services and another Bot", async () => {
  let alphaCalls = 0;
  let priorService = "";
  const fixture = await chatComputerFixture((request) => {
    if (JSON.stringify(request.messages).includes("BETA_LIFECYCLE")) {
      if (request.messages.some((message) => message.role === "tool"))
        return { text: "Beta finished" };
      return {
        tool: "shell",
        arguments: {
          command: "echo $$ > pid; until [ -f release ]; do sleep 0.05; done; echo beta-result",
        },
      };
    }
    alphaCalls++;
    if (alphaCalls === 1)
      return { tool: "start_service", arguments: { command: serviceCommand(8101) } };
    if (alphaCalls === 2) return { text: "Earlier service ready" };
    if (alphaCalls === 3)
      return {
        tools: [
          { name: "start_service", arguments: { command: serviceCommand(8102) } },
          {
            name: "shell",
            arguments: {
              command: "echo $$ > current-pid; until [ -f release ]; do sleep 0.05; done",
            },
          },
        ],
      };
    if (alphaCalls === 4) return { tool: "stop_service", arguments: { commandId: priorService } };
    return { text: "Earlier service stopped" };
  });
  try {
    const alpha = await fixture.request("bots", {
      name: "Alpha",
      instructions: "ALPHA_LIFECYCLE",
      model: "deepseek/deepseek-flash",
    });
    const beta = await fixture.request("bots", {
      name: "Beta",
      instructions: "BETA_LIFECYCLE",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${alpha.id}/send`, {
      text: "Start a service",
      requestId: "prior-service",
    });
    await expect
      .poll(async () => (await fixture.request(`bots/${alpha.id}/chat`)).busy, { timeout: 20000 })
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await fixture.provider.listCommands(fixture.computer)).some(
            (item) => item.service && item.retained,
          ),
        { timeout: 5000 },
      )
      .toBe(true);
    priorService =
      (await fixture.provider.listCommands(fixture.computer)).find((item) => item.retained)
        ?.commandId ?? "";
    expect(await serviceAnswers(fixture, 8101)).toBe(true);
    await fixture.reopen();
    expect(await serviceAnswers(fixture, 8101)).toBe(true);
    await fixture.request(`bots/${alpha.id}/send`, {
      text: "New service and command",
      requestId: "current-work",
    });
    await fixture.request(`bots/${beta.id}/send`, {
      text: "Work independently",
      requestId: "beta-work",
    });
    const file = (id: string, name: string) =>
      fixture.provider.readFile(fixture.computer, `bots/${id}/${name}`).catch(() => "");
    await expect.poll(() => file(alpha.id, "current-pid"), { timeout: 15000 }).not.toBe("");
    await expect.poll(() => file(beta.id, "pid"), { timeout: 15000 }).not.toBe("");
    await expect.poll(() => serviceAnswers(fixture, 8102), { timeout: 10000 }).toBe(true);
    await fixture.request(`bots/${alpha.id}/send`, {
      text: "Withdraw this input",
      requestId: "withdraw-current",
    });
    await fixture.request(`bots/${alpha.id}/stop`, {});
    expect(await serviceAnswers(fixture, 8101)).toBe(true);
    expect(await serviceAnswers(fixture, 8102)).toBe(false);
    const processes = await fixture.provider.execute(
      fixture.computer,
      `python3 -c 'from pathlib import Path; print(Path("/proc",Path("bots/${alpha.id}/current-pid").read_text().strip()).exists(),Path("/proc",Path("bots/${beta.id}/pid").read_text().strip()).exists())'`,
      "",
    );
    expect(processes.stdout).toBe("False True\n");
    const stopped = await fixture.request(`bots/${alpha.id}/chat`);
    expect(stopped.busy).toBe(false);
    expect(stopped.inputs).toContainEqual(
      expect.objectContaining({ requestId: "withdraw-current", status: "unanswered" }),
    );
    await fixture.provider.writeFile(fixture.computer, `bots/${beta.id}/release`, "go");
    await expect
      .poll(async () => (await fixture.request(`bots/${beta.id}/chat`)).busy, { timeout: 15000 })
      .toBe(false);
    expect((await fixture.request(`bots/${beta.id}/chat`)).messages.at(-1)?.text).toBe(
      "Beta finished",
    );
    await fixture.request(`bots/${alpha.id}/send`, {
      text: "Stop the earlier service",
      requestId: "stop-prior",
    });
    await expect
      .poll(async () => (await fixture.request(`bots/${alpha.id}/chat`)).busy, { timeout: 10000 })
      .toBe(false);
    expect(await serviceAnswers(fixture, 8101)).toBe(false);
    expect((await fixture.request(`bots/${alpha.id}/chat`)).messages.at(-1)?.text).toBe(
      "Earlier service stopped",
    );
  } finally {
    await fixture.close();
  }
});

test("a completed-turn service responds after normal whole-application shutdown", async () => {
  let calls = 0;
  const fixture = await chatComputerFixture(() =>
    ++calls === 1
      ? { tool: "start_service", arguments: { command: `${serviceCommand(8103)} &` } }
      : { text: "Service retained" },
  );
  try {
    const bot = await fixture.request("bots", {
      name: "Service",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Keep serving", requestId: "retain" });
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 20000 })
      .toBe(false);
    await fixture.shutdown();
    const reopened = new DockerSandbox(
      fixture.computer,
      join(fixture.root, "computer", "workspace"),
    );
    expect(
      (await reopened.listCommands(fixture.computer)).filter(
        (item) => item.retained && item.running,
      ),
    ).toHaveLength(1);
    expect(await serviceAnswers(fixture, 8103)).toBe(true);
    await docker("docker", ["rm", "-f", fixture.computer.id]);
    expect(await reopened.listCommands(fixture.computer)).toEqual([]);
    expect(
      (
        await reopened.execute(
          fixture.computer,
          "curl -fsS --max-time 1 http://127.0.0.1:8103/",
          "shared",
        )
      ).exitCode,
    ).not.toBe(0);
  } finally {
    await fixture.close();
  }
});

test("worker SIGKILL cleans interrupted work before native resume and preserves retained services and other Bots", async () => {
  let calls = 0;
  let observedBeforeResume = "";
  const fixture = await chatComputerFixture(async () => {
    calls++;
    if (calls === 1) return { tool: "start_service", arguments: { command: serviceCommand(8104) } };
    if (calls === 2) return { text: "Retain this service" };
    if (calls === 3)
      return {
        tools: [
          { name: "start_service", arguments: { command: serviceCommand(8105) } },
          {
            name: "shell",
            arguments: { command: "echo $$ > interrupted-pid; while :; do sleep 1; done" },
          },
        ],
      };
    // Observe the real process before responding to the first resumed model request.
    observedBeforeResume = (
      await fixture.provider.execute(
        fixture.computer,
        'python3 -c \'from pathlib import Path; print(Path("/proc", Path("interrupted-pid").read_text().strip()).exists())\'',
        `bots/${botId}`,
      )
    ).stdout;
    return { text: "Recovered work finished" };
  });
  let botId = "";
  try {
    const bot = await fixture.request("bots", {
      name: "Crash",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    botId = bot.id;
    const beta = await fixture.request("bots", {
      name: "Other",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, {
      text: "First service",
      requestId: "retain-before-crash",
    });
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 15000 })
      .toBe(false);
    await expect
      .poll(
        async () =>
          (await fixture.provider.listCommands(fixture.computer)).some((item) => item.retained),
        { timeout: 5000 },
      )
      .toBe(true);
    // This separate provider client has no interrupted worker invocation to recover.
    const control = await fixture.provider.startCommand(
      fixture.computer,
      serviceCommand(8110),
      `bots/${beta.id}`,
      { botId: beta.id, turnId: "999999" },
      true,
    );
    const admission = await fixture.request(`bots/${bot.id}/send`, {
      text: "Work before crash",
      requestId: "interrupted",
    });
    await expect
      .poll(
        async () =>
          (await fixture.provider.listCommands(fixture.computer)).filter(
            (item) => item.owner?.turnId === String(admission.id) && item.running,
          ).length,
        { timeout: 15000 },
      )
      .toBe(2);
    await expect.poll(() => serviceAnswers(fixture, 8105), { timeout: 10000 }).toBe(true);
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Resume after interruption",
      requestId: "resume-after-crash",
    });
    await fixture.crashWorker();
    await expect
      .poll(() => fixture.request("worker"), { timeout: 15000 })
      .toEqual({ state: "recovered" });
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 15000 })
      .toBe(false);
    expect(observedBeforeResume).toBe("False\n");
    expect(await serviceAnswers(fixture, 8104)).toBe(true);
    expect(await serviceAnswers(fixture, 8105)).toBe(false);
    expect(await serviceAnswers(fixture, 8110)).toBe(true);
    expect(
      (await fixture.provider.observeCommand(fixture.computer, control.commandId)).running,
    ).toBe(true);
    expect(
      (await fixture.provider.listCommands(fixture.computer)).filter(
        (item) => item.owner?.turnId === String(admission.id),
      ),
    ).toEqual([]);
    const view = await fixture.request(`bots/${bot.id}/chat`);
    expect(view.messages.map((item: { text: string }) => item.text).join(" ")).toContain(
      "interrupted and may have partially run",
    );
    expect(
      view.messages.filter(
        (item: { role: string; text: string }) =>
          item.role === "user" && item.text === "Work before crash",
      ),
    ).toHaveLength(1);
    expect(view.messages.at(-1)?.text).toBe("Recovered work finished");
  } finally {
    await fixture.close();
  }
});

test("deadlines and truncation remain observable with a shell slice for original bytes", async () => {
  const fixture = await computerFixture();
  const previous = process.env.SANDBOX_COMMAND_TIMEOUT_MS;
  try {
    process.env.SANDBOX_COMMAND_TIMEOUT_MS = "1000";
    const result = await fixture.provider.execute(
      fixture.computer,
      "echo $$ > pid; echo waiting; sleep 120",
      "shared",
    );
    expect(result).toMatchObject({ exitCode: 124, timedOut: true, stdout: "waiting\n" });
    const check = await fixture.provider.execute(
      fixture.computer,
      'python3 -c \'from pathlib import Path; print(Path("/proc", Path("pid").read_text().strip()).exists())\'',
      "shared",
    );
    expect(check.stdout).toBe("False\n");
    if (previous === undefined) delete process.env.SANDBOX_COMMAND_TIMEOUT_MS;
    else process.env.SANDBOX_COMMAND_TIMEOUT_MS = previous;
    const huge = await fixture.provider.execute(
      fixture.computer,
      'python3 -c \'from pathlib import Path; import sys; data="x"*70000+"ORIGINAL_TAIL"; Path("large.txt").write_text(data); print(data); sys.stderr.write("e"*70000)\'',
      "shared",
    );
    expect(huge).toMatchObject({ exitCode: 0, truncated: true });
    expect(Buffer.byteLength(huge.stdout)).toBe(65536);
    expect(Buffer.byteLength(huge.stderr)).toBe(65536);
    expect(
      (await fixture.provider.execute(fixture.computer, "tail -c 13 large.txt", "shared")).stdout,
    ).toBe("ORIGINAL_TAIL");
    expect(JSON.parse(await fixture.provider.listFiles(fixture.computer, "shared"))).toEqual({
      entries: ["large.txt", "pid"],
      truncated: false,
    });
    expect(
      (await fixture.provider.readFile(fixture.computer, "shared/large.txt")).endsWith(
        "ORIGINAL_TAIL",
      ),
    ).toBe(true);
  } finally {
    if (previous === undefined) delete process.env.SANDBOX_COMMAND_TIMEOUT_MS;
    else process.env.SANDBOX_COMMAND_TIMEOUT_MS = previous;
    await fixture.close();
  }
});

test("declared command-line facilities work with writable persistent home and cache paths", async () => {
  const fixture = await computerFixture();
  try {
    const result = await fixture.provider.execute(
      fixture.computer,
      `set -e
for tool in bash curl git gh jq ssh unzip ps pdftotext pdfinfo pandoc uv uvx; do command -v "$tool"; done
[ "$HOME" = /workspace/bots/tools ]
[ "$XDG_CACHE_HOME" = "$HOME/.cache" ]
[ "$UV_CACHE_DIR" = "$HOME/.cache/uv" ]
mkdir -p "$HOME/.local/bin" "$XDG_CACHE_HOME"
printf '#!/bin/sh\\necho local-bin\\n' > "$HOME/.local/bin/local-check"
chmod +x "$HOME/.local/bin/local-check"
local-check
git init --quiet repo
printf '{"value":42}' | jq -e '.value == 42'
printf '# Title' | pandoc -f markdown -t html | head -c 200
uv venv --offline --python /usr/local/bin/python3 .venv
.venv/bin/python -c 'print("venv works")'
python3 -c 'import openpyxl; book=openpyxl.Workbook(); book.active["A1"]="shared bytes"; book.save("sheet.xlsx"); assert openpyxl.load_workbook("sheet.xlsx").active["A1"].value == "shared bytes"'
gh --version
curl --version
pdfinfo -v
pdftotext -v
`,
      "bots/tools",
    );
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("local-bin");
    expect(result.stdout).toContain("venv works");
    expect(result.stdout).toContain('<h1 id="title">Title</h1>');
    expect(
      JSON.parse(await fixture.provider.listFiles(fixture.computer, "bots/tools")).entries,
    ).toContain("sheet.xlsx");
  } finally {
    await fixture.close();
  }
});

test("SDK persists live tool output while the real command is still running", async () => {
  const { computerTools, context, openAgent } = await import("@mybots/agent");
  const { startDurableModel } = await import("../durable-model-fixture.ts");
  const fixture = await computerFixture();
  let calls = 0;
  const model = await startDurableModel(() =>
    ++calls === 1
      ? {
          tool: "shell",
          arguments: {
            command: "printf 'LIVE_OUTPUT'; until [ -f release ]; do printf .; sleep 0.2; done",
          },
        }
      : { text: "Output observed" },
  );
  const harness = await openAgent(
    join(fixture.root, "durable.sqlite"),
    [model.config],
    [computerTools(fixture.provider, fixture.computer, () => "progress")],
  );
  let watch: import("@mybots/agent").ConversationWatch | undefined;
  try {
    const chat = await harness.createConversation(
      {
        ownership: { kind: "ownerless" },
        agent: { model: { provider: "controlled", modelId: "controlled-model" } },
      },
      context,
    );
    let progress = "";
    watch = await chat.watch(context);
    watch.start(async (state) => {
      const live = state.docs["pi.live"] as { tools?: { output?: string }[] } | undefined;
      progress = live?.tools?.map((tool) => tool.output ?? "").join("") ?? "";
    });
    const submission = await chat.submit(
      { type: "input", content: "Show running output" },
      context,
    );
    await expect.poll(() => progress, { timeout: 5000 }).toContain("LIVE_OUTPUT");
    expect(model.requests).toHaveLength(1);
    expect(
      (await fixture.provider.listCommands(fixture.computer)).some((item) => item.running),
    ).toBe(true);
    await fixture.provider.writeFile(fixture.computer, "bots/progress/release", "go");
    expect((await submission.wait(context)).status).toBe("done");
    expect(model.requests).toHaveLength(2);
  } finally {
    await watch?.stop();
    await harness.close(context);
    await model.close();
    await fixture.close();
  }
});

test("SDK truncation keeps command identity and exit metadata with a usable follow-up route", async () => {
  let calls = 0;
  const fixture = await chatComputerFixture(() =>
    ++calls === 1
      ? {
          tool: "shell",
          arguments: {
            command:
              'python3 -c \'from pathlib import Path; data="x"*70000+"END"; Path("output.txt").write_text(data); print(data)\'',
          },
        }
      : { text: "Bounded output received" },
  );
  try {
    const bot = await fixture.request("bots", {
      name: "Large output",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Produce output",
      requestId: "large-output",
    });
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 15000 })
      .toBe(false);
    const tool = String(
      fixture.service.requests[1]?.messages.find((message) => message.role === "tool")?.content,
    );
    expect(tool).toContain('"commandId":');
    expect(tool).toContain('"exitCode": 0');
    expect(tool).toContain('"truncated": true');
    expect(tool).not.toContain("END");
    expect(Buffer.byteLength(tool)).toBeLessThan(52000);
    expect(
      (await fixture.provider.execute(fixture.computer, "tail -c 3 output.txt", `bots/${bot.id}`))
        .stdout,
    ).toBe("END");
  } finally {
    await fixture.close();
  }
});

test("native queued input takes precedence while a final-answer hook observes unfinished work", async () => {
  let calls = 0;
  const fixture = await chatComputerFixture(() => {
    calls++;
    if (calls === 1)
      return { tool: "shell", arguments: { command: "echo waiting; while :; do sleep 1; done" } };
    if (calls === 2) return { text: "The command is still waiting." };
    if (calls === 3) return { text: "Checking the command." };
    return { text: "New instruction received" };
  });
  try {
    const bot = await fixture.request("bots", {
      name: "Final steering",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Run", requestId: "initial" });
    await fixture.service.waitForRequest(2);
    await expect
      .poll(
        async () =>
          (await fixture.request(`bots/${bot.id}/chat`)).messages
            .map((message: { text: string }) => message.text)
            .join("\n"),
        { timeout: 5000 },
      )
      .toContain("still waiting");
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Finish waiting and take this instruction",
      requestId: "final-steer",
    });
    await expect.poll(() => calls, { timeout: 5000 }).toBe(4);
    await expect
      .poll(async () => (await fixture.request(`bots/${bot.id}/chat`)).busy, { timeout: 5000 })
      .toBe(false);
    expect((await fixture.request(`bots/${bot.id}/chat`)).messages.at(-1)?.text).toBe(
      "New instruction received",
    );
  } finally {
    await fixture.close();
  }
});

test("shutdown reports failed Computer cleanup after releasing application resources", async () => {
  let calls = 0;
  const fixture = await chatComputerFixture(() =>
    ++calls === 1
      ? { tool: "start_service", arguments: { command: serviceCommand(8106) } }
      : { hold: true },
  );
  try {
    const bot = await fixture.request("bots", {
      name: "Cleanup failure",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, {
      text: "Start work",
      requestId: "cleanup-failure",
    });
    await fixture.service.waitForRequest(2);
    // Exercise a real provider failure without touching any installation Computer.
    await docker("docker", ["stop", "-t", "0", fixture.computer.id]);
    const stopped = await fetch(new URL(`api/bots/${bot.id}/stop`, fixture.url), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fixture.credential}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(stopped.status).toBe(400);
    expect((await fixture.request(`bots/${bot.id}/chat`)).activity.join(" ")).toContain(
      "Computer cleanup failed",
    );
    await expect(fixture.shutdown()).rejects.toThrow("Worker shutdown failed");
    // A failed cleanup must not retain the data-root owner lock.
    await fixture.reopen();
    expect((await fixture.request(`bots/${bot.id}/chat`)).busy).toBe(false);
  } finally {
    await fixture.close();
  }
});

test("unconfirmed crash cleanup fails visibly without resuming SDK work or hiding a live command", async () => {
  const { writeFile } = await import("node:fs/promises");
  const fixture = await chatComputerFixture(
    () => ({
      tool: "shell",
      arguments: { command: "echo $$ > pid; while :; do sleep 1; done" },
    }),
    { workerFaults: true },
  );
  try {
    const bot = await fixture.request("bots", {
      name: "Unsafe cleanup",
      instructions: "",
      model: "deepseek/deepseek-flash",
    });
    await fixture.request(`bots/${bot.id}/send`, { text: "Work", requestId: "cleanup-crash" });
    await expect
      .poll(
        () => fixture.provider.readFile(fixture.computer, `bots/${bot.id}/pid`).catch(() => ""),
        { timeout: 10000 },
      )
      .not.toBe("");
    const commands = await fixture.provider.listCommands(fixture.computer);
    const command = commands.find((item) => item.owner?.botId === bot.id);
    if (!command) throw new Error("Owned command unavailable");
    await writeFile(join(fixture.root, "worker-fault"), "hold");
    await fixture.crashWorker();
    // Losing the provider supervisor is a real unconfirmed-cleanup failure, not a mocked rejection.
    await docker("docker", [
      "exec",
      fixture.computer.id,
      "python3",
      "-c",
      `import json,os; from pathlib import Path; s=json.loads(Path('/tmp/mybots-commands/${command.commandId}/state.json').read_text()); os.kill(s['supervisor'],9)`,
    ]);
    await writeFile(join(fixture.root, "worker-fault"), "");
    await expect
      .poll(() => fixture.request("worker"), { timeout: 20000 })
      .toMatchObject({
        state: "failed",
        error: expect.stringContaining("Computer recovery cleanup failed"),
      });
    expect(fixture.service.requests).toHaveLength(1);
    const check = await docker("docker", [
      "exec",
      fixture.computer.id,
      "python3",
      "-c",
      `from pathlib import Path; print(Path('/proc',Path('/workspace/bots/${bot.id}/pid').read_text().strip()).exists())`,
    ]);
    expect(check.stdout).toBe("True\n");
    const response = await fetch(new URL(`api/bots/${bot.id}/chat`, fixture.url), {
      headers: { Authorization: `Bearer ${fixture.credential}` },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("execution has not resumed"),
    });
  } finally {
    await fixture.close();
  }
});
