import type { ErrorHandler, MiddlewareHandler } from "hono";

// Errors thrown by c.req.json() while parsing the request body. Kept by
// identity, so no other SyntaxError is ever mistaken for a bad body.
const bodyParseErrors = new WeakSet<object>();

/**
 * Records the error when `c.req.json()` fails to parse the request body. The
 * error itself is rethrown unchanged, so routes that catch a bad body keep
 * their own responses.
 */
export const trackJsonBodyParseErrors: MiddlewareHandler = async (c, next) => {
  const parse = c.req.json.bind(c.req);
  c.req.json = (async () => {
    try {
      return await parse();
    } catch (err) {
      if (err instanceof SyntaxError) bodyParseErrors.add(err);
      throw err;
    }
  }) as typeof c.req.json;
  await next();
};

/**
 * App-level error handler. Routes that read their body with a bare
 * `await c.req.json()` let a malformed body escape, which Hono's default
 * handler turns into a 500. That is a caller error, so answer 400.
 *
 * Every other error is handled exactly as Hono's default handler does,
 * including typed refusals that carry their own `getResponse()`.
 */
export const jsonBodyErrorHandler: ErrorHandler = (err, c) => {
  if (bodyParseErrors.has(err)) {
    return c.json({ error: "invalid_json", message: "Request body is not valid JSON." }, 400);
  }
  if ("getResponse" in err) {
    const res = (err as { getResponse: () => Response }).getResponse();
    return c.newResponse(res.body, res);
  }
  console.error(err);
  return c.text("Internal Server Error", 500);
};
