import { readSecureMediaFile } from "./secure-media-file";

export const CONTEXT_MEDIA_SCHEME = "fluely-media";
const CONTEXT_MEDIA_HOST = "context";
const SCREENSHOT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ContextMediaPathSource {
  getManagedPaths(ids: readonly string[]): string[];
  getManagedRoot?: () => string;
}

export type ContextMediaReader = (path: string, managedRoot?: string) => Promise<Uint8Array>;
export type ContextMediaHandler = (request: Request) => Promise<Response>;

function notFoundContextMedia(): Response {
  return new Response(null, {
    status: 404,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/** Serves only current working-queue PNGs through opaque context IDs. */
export function createContextMediaHandler(
  pathSource: ContextMediaPathSource,
  readManagedFile: ContextMediaReader = readSecureMediaFile,
): ContextMediaHandler {
  return async (request) => {
    if (request.method !== "GET") {
      return notFoundContextMedia();
    }

    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return notFoundContextMedia();
    }

    if (
      url.protocol !== `${CONTEXT_MEDIA_SCHEME}:` ||
      url.hostname !== CONTEXT_MEDIA_HOST ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return notFoundContextMedia();
    }

    const screenshotId = url.pathname.slice(1);
    if (!SCREENSHOT_ID_PATTERN.test(screenshotId)) {
      return notFoundContextMedia();
    }

    let managedPath: string | undefined;
    let managedRoot: string | undefined;
    try {
      managedPath = pathSource.getManagedPaths([screenshotId])[0];
      managedRoot = pathSource.getManagedRoot?.();
    } catch {
      return notFoundContextMedia();
    }
    if (!managedPath) {
      return notFoundContextMedia();
    }

    try {
      const image = await readManagedFile(managedPath, managedRoot);
      const body = new ArrayBuffer(image.byteLength);
      new Uint8Array(body).set(image);
      return new Response(body, {
        status: 200,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "image/png",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return notFoundContextMedia();
    }
  };
}
