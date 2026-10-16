import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readEnvFile } from "../packages/host/src/config/env-file.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function rootWith(contents: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "mybots-env-"));
  roots.push(root);
  await writeFile(join(root, ".env"), contents, { mode: 0o600 });
  return root;
}

describe("operator env file", () => {
  it("returns only requested keys and leaves the process environment unchanged", async () => {
    const root = await rootWith("ONECLI_URL=http://127.0.0.1:10254\nTELEGRAM_BOT_TOKEN=123:abc\n");
    const env = { PATH: "/usr/bin" };
    const before = { ...env };

    const values = await readEnvFile(root, ["ONECLI_URL"], env);

    expect(values).toEqual({ ONECLI_URL: "http://127.0.0.1:10254" });
    expect(env).toEqual(before);
    expect(await readFile(join(root, ".env"), "utf8")).toContain("TELEGRAM_BOT_TOKEN");
  });

  it("lets an existing process value override the file", async () => {
    const root = await rootWith("MODEL_ID=from-file\nMODEL_PROVIDER=deepseek\n");
    const values = await readEnvFile(root, ["MODEL_ID", "MODEL_PROVIDER"], {
      MODEL_ID: "from-process",
    });
    expect(values).toEqual({ MODEL_ID: "from-process", MODEL_PROVIDER: "deepseek" });
  });

  it("strips one matching pair of quotes and ignores blank assignments", async () => {
    const root = await rootWith(
      [
        'MODEL_PROVIDER="deepseek"',
        "MODEL_ID='deepseek-chat'",
        "MODEL_BASE_URL=",
        'CONTAINER_IMAGE="still-quoted',
        "# MODEL_MAX_TOKENS=1",
        "EGRESS_LOCKDOWN=true",
      ].join("\n"),
    );
    const values = await readEnvFile(
      root,
      [
        "MODEL_PROVIDER",
        "MODEL_ID",
        "MODEL_BASE_URL",
        "CONTAINER_IMAGE",
        "MODEL_MAX_TOKENS",
        "EGRESS_LOCKDOWN",
      ],
      {},
    );
    expect(values).toEqual({
      MODEL_PROVIDER: "deepseek",
      MODEL_ID: "deepseek-chat",
      CONTAINER_IMAGE: '"still-quoted',
      EGRESS_LOCKDOWN: "true",
    });
  });

  it("does not execute shell or expand variables", async () => {
    const root = await rootWith(
      'ONECLI_API_KEY=$(echo leak)\nONECLI_URL="http://127.0.0.1:$PORT"\n',
    );
    const values = await readEnvFile(root, ["ONECLI_API_KEY", "ONECLI_URL"], { PORT: "9" });
    expect(values).toEqual({
      ONECLI_API_KEY: "$(echo leak)",
      ONECLI_URL: "http://127.0.0.1:$PORT",
    });
  });
});
