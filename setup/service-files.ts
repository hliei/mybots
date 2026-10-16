import { createHash } from "node:crypto";
import { join } from "node:path";

export function installSlug(root: string, override?: string): string {
  if (override !== undefined) {
    if (!/^[a-z0-9]([a-z0-9_-]{0,31})$/u.test(override)) {
      throw new Error(
        "MYBOTS_INSTALL_ID must be 1-32 characters of lowercase letters, digits, underscores or hyphens, starting with a letter or digit.",
      );
    }
    return override;
  }
  return createHash("sha1").update(root).digest("hex").slice(0, 8);
}

export function serviceLabel(slug: string): string {
  return `com.mybots.${slug}`;
}

export function serviceUnitName(slug: string): string {
  return `mybots-${slug}.service`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface ServicePaths {
  root: string;
  nodePath: string;
  home: string;
  slug: string;
  path: string;
  proxy: Record<string, string>;
}

function proxyEntries(proxy: Record<string, string>): [string, string][] {
  const httpsProxy = proxy.HTTPS_PROXY || proxy.ALL_PROXY || proxy.HTTP_PROXY;
  const httpProxy = proxy.HTTP_PROXY || proxy.ALL_PROXY || proxy.HTTPS_PROXY;
  if (!httpsProxy || !httpProxy) return [];
  const noProxy = new Set(
    (proxy.NO_PROXY ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  for (const item of ["127.0.0.1", "localhost", "::1", "[::1]"]) noProxy.add(item);
  return Object.entries({
    NODE_USE_ENV_PROXY: "1",
    HTTPS_PROXY: httpsProxy,
    HTTP_PROXY: httpProxy,
    NO_PROXY: [...noProxy].join(","),
  });
}

export function renderLaunchdPlist(input: ServicePaths): string {
  const label = serviceLabel(input.slug);
  const variables = [["PATH", input.path], ["HOME", input.home], ...proxyEntries(input.proxy)];
  const environment = variables
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>WorkingDirectory</key>
  <string>${xml(input.root)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(input.nodePath)}</string>
    <string>${xml(join(input.root, "packages/host/dist/index.js"))}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(join(input.root, "logs/mybots.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(join(input.root, "logs/mybots.error.log"))}</string>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
</dict>
</plist>
`;
}

export function renderSystemdUnit(input: ServicePaths): string {
  const environment = [["PATH", input.path], ["HOME", input.home], ...proxyEntries(input.proxy)]
    .map(([key, value]) => `Environment=${JSON.stringify(`${key}=${value}`.replaceAll("%", "%%"))}`)
    .join("\n");
  return `[Unit]
Description=Mybots host

[Service]
WorkingDirectory=${input.root}
ExecStart=${input.nodePath} ${join(input.root, "packages/host/dist/index.js")}
Restart=always
StandardOutput=append:${join(input.root, "logs/mybots.log")}
StandardError=append:${join(input.root, "logs/mybots.error.log")}
${environment}

[Install]
WantedBy=default.target
`;
}

export function renderStartScript(input: ServicePaths): string {
  return `#!/bin/bash
set -euo pipefail
cd ${shellQuote(input.root)}
mkdir -p logs
if [[ -f data/service-proxy.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source data/service-proxy.env
  set +a
fi
if [[ -f mybots.pid ]] && kill -0 "$(cat mybots.pid)" 2>/dev/null; then
  previous_pid="$(cat mybots.pid)"
  kill "$previous_pid" || true
  for ((attempt = 0; attempt < 300; attempt++)); do
    if ! kill -0 "$previous_pid" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done
  if kill -0 "$previous_pid" 2>/dev/null; then
    echo "The previous Mybots host did not stop within 30 seconds." >&2
    exit 1
  fi
fi
nohup ${shellQuote(input.nodePath)} packages/host/dist/index.js >> logs/mybots.log 2>> logs/mybots.error.log &
echo $! > mybots.pid
`;
}

export function proxyAssignments(proxy: Record<string, string>): string {
  return `${proxyEntries(proxy)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join("\n")}\n`;
}

export function launchdPlistPath(home: string, slug: string): string {
  return join(home, "Library", "LaunchAgents", `${serviceLabel(slug)}.plist`);
}

export function systemdUserPath(home: string, slug: string): string {
  return join(home, ".config", "systemd", "user", serviceUnitName(slug));
}

export function systemdSystemPath(slug: string): string {
  return join("/etc/systemd/system", serviceUnitName(slug));
}
