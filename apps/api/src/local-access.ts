import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { join } from "node:path";

const COOKIE = "mybots_connection";

/** One installation credential, kept outside both the built Web and Computer workspace. */
export class LocalAccess {
  private readonly credential: string;

  private constructor(credential: string) {
    this.credential = credential;
  }

  static async load(root: string): Promise<LocalAccess> {
    const file = join(root, "client-credential");
    try {
      await writeFile(file, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await chmod(file, 0o600);
    const credential = (await readFile(file, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/u.test(credential))
      throw new Error("Invalid local client credential file");
    return new LocalAccess(credential);
  }

  rejection(request: IncomingMessage, authenticated = true): 401 | 403 | undefined {
    const address = request.socket.address();
    if (!("port" in address)) return 403;
    const authority = request.headers.host;
    const allowed = ["127.0.0.1", "localhost", "[::1]"].flatMap((host) =>
      address.port === 80 ? [host, `${host}:80`] : [`${host}:${address.port}`],
    );
    if (!authority || !allowed.includes(authority)) return 403;
    if (
      request.headers.origin !== undefined &&
      request.headers.origin !== new URL(`http://${authority}`).origin
    )
      return 403;
    if (request.headers["sec-fetch-site"] === "cross-site") return 403;
    if (!authenticated) return undefined;
    const authorization = request.headers.authorization;
    const cookie = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith(`${COOKIE}=`))
      ?.slice(COOKIE.length + 1);
    const supplied =
      authorization !== undefined
        ? authorization.startsWith("Bearer ")
          ? authorization.slice(7)
          : undefined
        : cookie;
    if (!supplied || !/^[a-f0-9]{64}$/u.test(supplied)) return 401;
    return timingSafeEqual(Buffer.from(supplied), Buffer.from(this.credential)) ? undefined : 401;
  }

  cookie(): string {
    return `${COOKIE}=${this.credential}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  }
}
