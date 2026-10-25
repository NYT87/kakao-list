// Local contract fixture, not a Kakao implementation. Never use real credentials.
const http = require("node:http");
http
  .createServer(async (request, response) => {
    let raw = request.body;
    if (raw === undefined) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      raw = Buffer.concat(chunks).toString();
    }
    const body = new URLSearchParams(
      typeof raw === "object" ? raw : String(raw ?? ""),
    );
    const url = new URL(request.url, "http://fixture");
    response.setHeader("Content-Type", "application/json");
    if (url.pathname.endsWith("/oauth/token") && request.method === "POST") {
      if (body.get("code") === "upstream-error") {
        response.statusCode = 500;
        response.end(JSON.stringify({ error: "internal_secret=never-leak" }));
        return;
      }
      if (body.get("code") === "timeout") {
        setTimeout(() => response.end("{}"), 6000);
        return;
      }
      if (body.get("grant_type") === "refresh_token") {
        response.end(
          JSON.stringify({
            access_token: "fixture-user-1",
            refresh_token: "fixture-refresh",
          }),
        );
        return;
      }
      if (
        body.get("grant_type") !== "authorization_code" ||
        !body.get("redirect_uri") ||
        !body.get("client_id") ||
        !body.get("code")
      ) {
        response.statusCode = 400;
        response.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }
      response.end(
        JSON.stringify({
          access_token: `fixture-${body.get("code")}`,
          refresh_token: "fixture-refresh",
          token_type: "bearer",
          expires_in: 21600,
        }),
      );
      return;
    }
    if (url.pathname.endsWith("/v2/user/me")) {
      const token = request.headers.authorization?.replace(/^Bearer /, "");
      if (!token?.startsWith("fixture-")) {
        response.statusCode = 401;
        response.end(JSON.stringify({ code: -401, msg: "Unauthorized" }));
        return;
      }
      response.end(
        JSON.stringify({
          id: token.slice(8),
          kakao_account: { profile: { nickname: "Fixture User" } },
        }),
      );
      return;
    }
    response.statusCode = 501;
    response.end(
      JSON.stringify({ error: "Endpoint outside fixture contract" }),
    );
  })
  .listen(Number(process.env.PORT ?? 4499), "127.0.0.1");
