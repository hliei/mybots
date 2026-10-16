export class SetupError extends Error {}

/** Confirm the management API the current SDK calls is present. */
export async function checkGatewayHealth(url: string, fetchImpl: typeof fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(new URL("/v1/health", url), {
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new SetupError(`OneCLI health check failed at ${url}.`);
  }
  if (response.status === 404) {
    throw new SetupError(
      `The gateway at ${url} does not provide /v1. Upgrade OneCLI to 1.42.0 before starting the host.`,
    );
  }
  if (!response.ok) throw new SetupError(`OneCLI health check failed at ${url}.`);
}

interface SecretRecord {
  id: string;
  hostPattern: string;
}

function records(value: unknown): SecretRecord[] {
  const list = Array.isArray(value)
    ? value
    : value && typeof value === "object" && "data" in value && Array.isArray(value.data)
      ? value.data
      : [];
  return list.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as { id?: unknown; hostPattern?: unknown };
    if (typeof record.id !== "string" || typeof record.hostPattern !== "string") return [];
    return [{ id: record.id, hostPattern: record.hostPattern }];
  });
}

export interface RegisteredSecret {
  id: string;
  created: boolean;
}

/** Create or update the single bearer secret for one exact hostname, then grant it to the Agent. */
export async function registerBearerSecret(input: {
  url: string;
  apiKey: string;
  projectId?: string;
  hostname: string;
  value: string;
  agentId: string;
  fetchImpl: typeof fetch;
}): Promise<RegisteredSecret> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (input.apiKey) headers.Authorization = `Bearer ${input.apiKey}`;
  if (input.projectId) headers["X-Project-Id"] = input.projectId;
  const base = input.url.replace(/\/$/u, "");
  const agent = await input.fetchImpl(`${base}/v1/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: input.agentId, identifier: input.agentId }),
  });
  if (!agent.ok && agent.status !== 409) {
    throw new SetupError(`OneCLI could not ensure agent ${input.agentId}.`);
  }
  let agentRecord: { id?: unknown; identifier?: unknown };
  if (agent.status === 409) {
    const listed = await input.fetchImpl(`${base}/v1/agents`, { headers });
    if (!listed.ok) throw new SetupError("OneCLI could not list agents.");
    const agents = (await listed.json()) as { id?: unknown; identifier?: unknown }[];
    agentRecord = agents.find((item) => item.identifier === input.agentId) ?? {};
  } else {
    agentRecord = await agent.json();
  }
  if (typeof agentRecord.id !== "string") {
    throw new SetupError(`OneCLI did not return an id for agent ${input.agentId}.`);
  }
  const listed = await input.fetchImpl(`${base}/v1/secrets`, { headers });
  if (!listed.ok) throw new SetupError("OneCLI could not list secrets.");
  const existing = records(await listed.json()).find(
    (secret) => secret.hostPattern === input.hostname,
  );
  const body = {
    name: input.hostname,
    type: "generic",
    value: input.value,
    hostPattern: input.hostname,
    injectionConfig: { headerName: "Authorization", valueFormat: "Bearer {value}" },
  };
  const saved = existing
    ? await input.fetchImpl(`${base}/v1/secrets/${existing.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      })
    : await input.fetchImpl(`${base}/v1/secrets`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
  if (!saved.ok) throw new SetupError(`OneCLI could not save the secret for ${input.hostname}.`);
  const payload: unknown = await saved.json();
  const returned =
    payload && typeof payload === "object" && "id" in payload && typeof payload.id === "string"
      ? payload.id
      : undefined;
  const id = returned ?? existing?.id;
  if (!id) throw new SetupError(`OneCLI did not return a secret id for ${input.hostname}.`);
  const grantUrl = `${base}/v1/agents/${agentRecord.id}/secrets`;
  const current = await input.fetchImpl(grantUrl, { headers });
  if (!current.ok) throw new SetupError("OneCLI could not read the Agent's secret grants.");
  const secretIds = (await current.json()) as string[];
  const grant = await input.fetchImpl(grantUrl, {
    method: "PUT",
    headers,
    body: JSON.stringify({ secretIds: [...new Set([...secretIds, id])] }),
  });
  if (!grant.ok) {
    throw new SetupError(`OneCLI could not grant the secret to agent ${input.agentId}.`);
  }
  return { id, created: !existing };
}
