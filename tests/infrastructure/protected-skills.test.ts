import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { provisionSession } from "../../packages/host/src/container-runner.ts";
import { DockerDriver } from "../../packages/host/src/drivers/docker-driver.ts";
import type { SessionHandle } from "../../packages/host/src/drivers/types.ts";
import { LocalSkills } from "../../packages/host/src/skills.ts";

const execute = promisify(execFile);
test("actual production mounts protect selected Skills while proposals remain writable", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybots-skill-mounts-"));
  const network = `mybots-skills-${randomUUID()}`;
  const handles: SessionHandle[] = [];
  try {
    const source = join(root, "source");
    await mkdir(source);
    await writeFile(
      join(source, "SKILL.md"),
      "---\nname: brief\ndescription: Reviewed brief\n---\nReviewed content",
    );
    const library = new LocalSkills(root);
    const revision = library.import("personal", { id: "brief", path: source });
    const other = library.import("writer", { id: "brief", path: source });
    const trustFile = join(root, "data", "gateway-trust", "ca.pem");
    await mkdir(join(trustFile, ".."), { recursive: true });
    await writeFile(trustFile, await readFile("tests/fixtures/gateway/public-ca.pem"));
    await execute("docker", ["network", "create", "--internal", network]);
    const driver = new DockerDriver({
      image: "mybots-agent:mailbox",
      network,
      gateway: {
        ensure: async () => ({
          trustFile,
          env: {
            HTTPS_PROXY: "http://127.0.0.1:9999",
            HTTP_PROXY: "http://127.0.0.1:9999",
            NODE_EXTRA_CA_CERTS: "/run/gateway/ca.pem",
          },
        }),
      },
    });
    for (const selection of [revision, other]) {
      const botId = selection === revision ? "personal" : "writer";
      const material = await provisionSession({
        root,
        key: { agentGroupId: botId, sessionId: "skill-check" },
        folder: botId,
        model: {
          provider: "deepseek",
          id: "deepseek-chat",
          baseUrl: "https://api.deepseek.com",
          contextWindow: 65536,
          maxTokens: 8192,
        },
        resources: {
          skills: ["brief"],
          skillRevisions: { brief: selection.revision },
          tools: ["read", "write", "edit", "bash"],
        },
      });
      library.materialize(botId, { brief: selection.revision }, material.skillsDirectory);
      const handle = await driver.start(material, new AbortController().signal);
      handles.push(handle);
      const container = handle.ref as string;
      const inspect = JSON.parse((await execute("docker", ["inspect", container])).stdout)[0];
      expect(
        inspect.Mounts.find(
          (mount: { Destination: string }) => mount.Destination === "/session/skills",
        ),
      ).toMatchObject({ RW: false });
      for (const script of [
        "echo altered > /session/skills/brief/SKILL.md",
        "rm /session/skills/brief/SKILL.md",
        "mv /session/skills/brief /session/skills/replaced",
        "chmod u+w /session/skills/brief/SKILL.md",
        "ln -sf /tmp/replacement /session/skills/brief/SKILL.md",
      ])
        await expect(execute("docker", ["exec", container, "sh", "-c", script])).rejects.toThrow();
      await execute("docker", [
        "exec",
        container,
        "sh",
        "-c",
        "mkdir -p /workspace/group/skills/brief && echo proposed > /workspace/group/skills/brief/SKILL.md",
      ]);
      expect(
        (await execute("docker", ["exec", container, "cat", "/session/skills/brief/SKILL.md"]))
          .stdout,
      ).toContain("Reviewed content");
      expect(
        await readFile(join(material.workspace, "skills", "brief", "SKILL.md"), "utf8"),
      ).toContain("proposed");
      expect(
        (
          await execute("docker", [
            "exec",
            container,
            "sh",
            "-c",
            "test ! -e /data/host.db && test ! -e /var/run/docker.sock",
          ])
        ).stderr,
      ).toBe("");
    }
    expect(library.list("personal")).toEqual([revision]);
    expect(library.list("writer")).toEqual([other]);
  } finally {
    for (const handle of handles) await handle.stop();
    await execute("docker", ["network", "rm", network]).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});
