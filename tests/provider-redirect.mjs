// Loaded only by test processes: keep production endpoints fixed and all fixture traffic offline.
const fixture = JSON.parse(process.env.MYBOTS_PROVIDER_FIXTURE);
const { deepseekProvider } = await import("../packages/agent/node_modules/@earendil-works/pi-ai/dist/providers/deepseek.js");
if (fixture.contextWindow) {
  for (const model of deepseekProvider().getModels()) model.contextWindow = fixture.contextWindow;
}
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (url.hostname !== "api.deepseek.com" && url.hostname !== "opencode.ai")
    throw new Error("Unexpected public request in provider fixture");
  const redirected = new URL(url.pathname + url.search, fixture.url);
  return fetchOriginal(new Request(redirected, request));
};
