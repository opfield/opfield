import type { Context, MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

const JSON_CONTENT_TYPE = /^application\/(?:[\w.+-]+\+)?json\b/i;

/** Whether the request carries no body, decided without reading it. */
function hasNoBody(c: Context): boolean {
  const headers = c.req.raw.headers;
  const length = headers.get('content-length');
  if (length !== null) return Number(length) === 0;
  if (headers.has('transfer-encoding')) return false;
  // An HTTP/1.1 request with neither header has no body; a Request built in process tells itself.
  const incoming = (c.env as { incoming?: { httpVersionMajor?: number } } | undefined)?.incoming;
  return incoming ? incoming.httpVersionMajor === 1 : c.req.raw.body === null;
}

/**
 * An empty body is no body. A client that sends `Content-Type: application/json` without
 * one made the JSON validator of a route with an optional body answer 400 "Malformed JSON";
 * without the content type it validates as no body, as when the header is left out.
 */
export const emptyJsonBodyMiddleware: MiddlewareHandler = async (c, next) => {
  const contentType = c.req.raw.headers.get('content-type');
  if (contentType && JSON_CONTENT_TYPE.test(contentType) && hasNoBody(c)) {
    c.req.raw.headers.delete('content-type');
  }
  rejectMalformedJsonAsBadRequest(c);
  await next();
};

/**
 * Routes that read `c.req.json()` themselves (no OpenAPI JSON validator) let the parser's SyntaxError reach the
 * error handler as an unhandled 500. A body that is not JSON is the client's error: answer it as the validator does.
 */
function rejectMalformedJsonAsBadRequest(c: Context): void {
  const parse = c.req.json.bind(c.req);
  c.req.json = (async () => {
    try {
      return await parse();
    } catch (error) {
      if (error instanceof SyntaxError) throw new HTTPException(400, { message: 'Malformed JSON in request body' });
      throw error;
    }
  }) as typeof c.req.json;
}
