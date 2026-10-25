import app from "../src/index.js";

// Readiness and safe public errors are handled by the shared middleware.
export default function handler(request: unknown, response: unknown) {
  return app(request as never, response as never);
}
