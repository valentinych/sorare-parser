import type { FastifyRequest } from "fastify";

/** Browser document navigation vs XHR/fetch/inject JSON. */
export function wantsHtmlPage(request: FastifyRequest): boolean {
  const accept = String(request.headers.accept || "");
  if (/application\/json/i.test(accept) && !/text\/html/i.test(accept)) return false;
  const dest = String(request.headers["sec-fetch-dest"] || "");
  if (dest === "document") return true;
  if (dest === "empty" || dest === "cors") return false;
  if (!accept || accept === "*/*") return false;
  return /text\/html/i.test(accept);
}
