import { ProviderSettings } from "@mybots/db";
import { type ApiServer, startApi } from "../apps/api/src/server.ts";
import type { startDurableModel } from "./durable-model-fixture.ts";

type ModelService = Awaited<ReturnType<typeof startDurableModel>>;
export function fixtureEnvironment(service: ModelService, workerFaults = false): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("./provider-redirect.mjs", import.meta.url).pathname}${workerFaults ? ` --import=${new URL("./worker-fault.mjs", import.meta.url).pathname}` : ""}`,
    MYBOTS_PROVIDER_FIXTURE: JSON.stringify({
      url: service.config.baseUrl,
      contextWindow: service.contextWindow,
    }),
  };
}
export function configureFixture(root: string): void {
  const settings = new ProviderSettings(root);
  settings.update("deepseek", "fixture-key");
  settings.update("opencode-go", "fixture-go-key");
}
export async function startFixtureApi(
  root: string,
  service: ModelService,
  workerFaults = false,
): Promise<ApiServer> {
  const previous = {
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    MYBOTS_PROVIDER_FIXTURE: process.env.MYBOTS_PROVIDER_FIXTURE,
  };
  const environment = fixtureEnvironment(service, workerFaults);
  process.env.NODE_OPTIONS = environment.NODE_OPTIONS;
  process.env.MYBOTS_PROVIDER_FIXTURE = environment.MYBOTS_PROVIDER_FIXTURE;
  try {
    return await startApi(root);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}
