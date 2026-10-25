# Kakao identity verification fixture

This local mock models only form-encoded code/refresh exchange and bearer-authenticated `/v2/user/me`, matching the fields consumed by this app. No owner workspace mock was available in this local task; the fixture is maintained from the app contract, not certified by Kakao.

Start with `postman mock run postman/mocks/kakao --port 4499 --no-history --output ndjson`. This machine has CLI 1.69.0, which does not support the skill's newer `postman simulation` command; use the single-service mock directly. Run the main API PostgreSQL tests with `KAKAO_SIMULATION_URL=http://127.0.0.1:4499` and `TEST_DATABASE_URL` set to an isolated test database. The application itself is real Express code with real PostgreSQL; only Kakao HTTP is replaced.

Codes `user-1` and `user-2` identify separate test users. `upstream-error` returns a secret-bearing 500 payload to check public error sanitization; `timeout` exceeds the server's five-second upstream deadline. Every unmodeled path returns 501. These fixtures contain no production secrets. Never point them at a production database.

Verification results and limitations are recorded in docs/remediation-status.md after the run. Live Kakao account identity, browser consent, and private Maps endpoint behavior still require manual verification.
