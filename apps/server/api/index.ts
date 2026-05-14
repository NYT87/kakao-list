import app, { ensureServerReady } from "../src/index.js";

export default async function handler(request: unknown, response: unknown) {
  await ensureServerReady();
  return app(request as never, response as never);
}
