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
  const products = new ProductDatabase(join(fixture.root, "data", "product.sqlite"));
  const computer = products.computer();
  products.close();
  try {
    const bot = await fixture.request("bots", {
      name: "Tool user",
      instructions: "",
      model: "controlled",
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
  const database = new ProductDatabase(join(fixture.root, "data", "product.sqlite"));
  const computer = database.computer();
  database.close();
  const provider = new DockerSandbox(computer, join(fixture.root, "computer", "workspace"));
  try {
    const bot = await fixture.request("bots", {
      name: "Busy",
      instructions: "",
      model: "controlled",
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
