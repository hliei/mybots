import { createHash, X509Certificate } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OneCLI } from "@onecli-sh/sdk";
import type { SessionKey } from "../mailbox/types.ts";
import type { GatewayContribution, GatewayProvider } from "./types.ts";

export interface OneCliOptions {
  url: string;
  apiKey?: string;
  projectId?: string;
  /** Gateway address on the runner's isolated Docker network. */
  proxyHost: string;
  trustDirectory: string;
}

export class OneCliGateway implements GatewayProvider {
  private readonly options: OneCliOptions;
  constructor(options: OneCliOptions) {
    this.options = options;
  }
  async ensure(key: SessionKey, signal: AbortSignal): Promise<GatewayContribution> {
    try {
      const base = new URL(this.options.url);
      if (
        !["http:", "https:"].includes(base.protocol) ||
        base.username ||
        base.password ||
        base.search ||
        base.hash
      )
        throw new Error();
      if (!/^[a-zA-Z0-9.-]+$/.test(this.options.proxyHost)) throw new Error();
      signal.throwIfAborted();
      const response = await fetch(new URL("/v1/health", base), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        redirect: "error",
      });
      if (!response.ok) throw new Error();
      const client = new OneCLI({
        url: base.href.replace(/\/$/, ""),
        apiKey: this.options.apiKey ?? "",
        projectId: this.options.projectId,
        timeout: 5000,
      });
      await client.ensureAgent({ name: key.agentGroupId, identifier: key.agentGroupId });
      const config = await client.getContainerConfig({ agent: key.agentGroupId });
      signal.throwIfAborted();
      const proxy = new URL(config.env.HTTPS_PROXY);
      if (
        proxy.protocol !== "http:" ||
        !proxy.password ||
        !proxy.port ||
        proxy.search ||
        proxy.hash
      )
        throw new Error();
      if (config.env.HTTP_PROXY !== config.env.HTTPS_PROXY) throw new Error();
      const permitted = new Set([
        "HTTPS_PROXY",
        "HTTP_PROXY",
        "https_proxy",
        "http_proxy",
        "NODE_EXTRA_CA_CERTS",
        "NODE_USE_ENV_PROXY",
        "GIT_TERMINAL_PROMPT",
        "GIT_HTTP_PROXY_AUTHMETHOD",
        "ANTHROPIC_API_KEY",
        "OPENAI_API_KEY",
        "CLAUDE_CODE_OAUTH_TOKEN",
      ]);
      for (const [name, value] of Object.entries(config.env)) {
        if (!permitted.has(name)) throw new Error();
        if (
          ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"].includes(name) &&
          value !== "placeholder"
        )
          throw new Error();
      }
      // Pi needs no gateway-supplied login files or other harness credentials.
      if (config.credentialStubs?.length) throw new Error();
      const certificate = new X509Certificate(config.caCertificate);
      if (certificate.toString().trim() !== config.caCertificate.trim()) throw new Error();
      const digest = createHash("sha256").update(certificate.raw).digest("hex");
      await mkdir(this.options.trustDirectory, { recursive: true });
      const trustFile = join(this.options.trustDirectory, `${digest}.pem`);
      await writeFile(trustFile, certificate.toString(), { mode: 0o444, flag: "wx" }).catch(
        async (error) => {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          if (
            (await lstat(trustFile)).isSymbolicLink() ||
            (await readFile(trustFile, "utf8")) !== certificate.toString()
          )
            throw new Error();
        },
      );
      proxy.hostname = this.options.proxyHost;
      return {
        env: {
          HTTPS_PROXY: proxy.href,
          HTTP_PROXY: proxy.href,
          NODE_EXTRA_CA_CERTS: "/run/gateway/ca.pem",
        },
        trustFile,
      };
    } catch {
      throw new Error(
        "OneCLI gateway unavailable or unusable; check management access, scoped proxy and public CA configuration.",
      );
    }
  }
}
