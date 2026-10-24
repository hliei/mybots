import { DockerSandbox, resolveWorkingPath } from "@mybots/sandbox";
import { expect, test } from "vitest";

test("Bot defaults and explicit shared/root paths resolve consistently", () => {
  expect(resolveWorkingPath("writer")).toBe("bots/writer");
  expect(resolveWorkingPath("writer", "notes.txt")).toBe("bots/writer/notes.txt");
  expect(resolveWorkingPath("reader", "shared/source.txt")).toBe("shared/source.txt");
  expect(resolveWorkingPath("reader", "/shared/source.txt")).toBe("shared/source.txt");
  expect(resolveWorkingPath("reader", "bots/writer/notes.txt")).toBe("bots/writer/notes.txt");
  expect(resolveWorkingPath("reader", "/")).toBe("");
});

test("tool paths and application-owned Computer identity reject invalid inputs before Docker use", () => {
  for (const path of ["../secret", "/shared/../secret", "bad\0path", "C:\\host"]) {
    expect(() => resolveWorkingPath("writer", path)).toThrow();
  }
  expect(() => resolveWorkingPath("../host", "file")).toThrow();
  expect(() => new DockerSandbox({ id: "--privileged" }, "/tmp/work")).toThrow();
  expect(
    () =>
      new DockerSandbox(
        { id: "mybots-00000000-0000-0000-0000-000000000000" },
        "/tmp/work,source=/",
      ),
  ).toThrow();
});
