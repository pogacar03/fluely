import { readSecureMediaFile } from "./secure-media-file";

export const SESSION_MEDIA_SCHEME = "fluely-media";

const CONTEXT_MEDIA_HOST = "context";
const ATTACHMENT_MEDIA_HOST = "attachment";
const OPAQUE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionContextMediaSource {
  getManagedPaths(ids: readonly string[]): string[];
}

export interface SessionAttachmentMediaSource {
  getPath(id: string): string | undefined;
}

export type SessionMediaReader = (path: string) => Promise<Uint8Array>;
export type SessionMediaHandler = (request: Request) => Promise<Response>;

export interface SessionMediaHandlerOptions {
  context: SessionContextMediaSource;
  attachments: SessionAttachmentMediaSource;
  readManagedFile?: SessionMediaReader;
}

function notFound(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function parseOpaqueId(pathname: string): string | undefined {
  if (!pathname.startsWith("/") || pathname.length <= 1 || pathname.includes("/", 1)) {
    return undefined;
  }

  let id: string;
  try {
    id = decodeURIComponent(pathname.slice(1));
  } catch {
    return undefined;
  }

  return OPAQUE_ID_PATTERN.test(id) ? id : undefined;
}

/**
 * Serves current-session PNGs through opaque IDs only. The managed filesystem
 * paths never cross the protocol boundary and are read only after namespace
 * and ID validation.
 */
export function createSessionMediaHandler(
  options: SessionMediaHandlerOptions,
): SessionMediaHandler {
  const readManagedFile = options.readManagedFile ?? readSecureMediaFile;

  return async (request) => {
    if (request.method !== "GET") {
      return notFound();
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }

    if (
      url.protocol !== `${SESSION_MEDIA_SCHEME}:` ||
      ![CONTEXT_MEDIA_HOST, ATTACHMENT_MEDIA_HOST].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return notFound();
    }

    const id = parseOpaqueId(url.pathname);
    if (!id) {
      return notFound();
    }

    let managedPath: string | undefined;
    try {
      if (url.hostname === CONTEXT_MEDIA_HOST) {
        managedPath = options.context.getManagedPaths([id])[0];
      } else {
        managedPath = options.attachments.getPath(id);
      }
    } catch {
      return notFound();
    }

    if (!managedPath) {
      return notFound();
    }

    try {
      const image = await readManagedFile(managedPath);
      const body = new ArrayBuffer(image.byteLength);
      new Uint8Array(body).set(image);
      return new Response(body, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Length": String(image.byteLength),
          "Content-Type": "image/png",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return notFound();
    }
  };
}
