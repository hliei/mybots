import { createHash } from "node:crypto";

/** Stable service identity shared by installation and daily startup. */
export function installSlug(root: string, override?: string): string {
  if (override !== undefined) {
    if (!/^[a-z0-9]([a-z0-9_-]{0,31})$/u.test(override))
      throw new Error(
        "MYBOTS_INSTALL_ID must be 1-32 characters of lowercase letters, digits, underscores or hyphens, starting with a letter or digit.",
      );
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
