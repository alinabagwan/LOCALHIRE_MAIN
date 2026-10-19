# Production Readiness Audit

## 1) Scope and project reality

Project root: the workspace root currently used for LocalHire.

Verified stack from the repository and runtime checks:

- Frontend: static HTML, CSS, and JavaScript pages under the root and [js](js) / [pages](pages). No active frontend framework is configured in the repo; this is a classic multi-page app rather than React/Vite/Next.
- Backend: Express app in [server/server.js](server/server.js) with route mounts under [server/routes](server/routes).
- Persistence: the codebase is in a mixed migration state. The real live system in the current repo uses PostgreSQL via Prisma. Legacy MongoDB/Mongoose support remains in [server/config/db.js](server/config/db.js), [server/models](server/models), and package metadata, but the active runtime checks and schema are Prisma-based.
- Auth: JWT-based authentication through [server/controllers/authController.js](server/controllers/authController.js) and [server/middlewares/authMiddleware.js](server/middlewares/authMiddleware.js).
- API structure: REST endpoints under [server/routes](server/routes), Socket.IO layer in [server/server.js](server/server.js), and frontend API abstraction in [js/api.js](js/api.js).
- WebSocket: Socket.IO server with authenticated handshake in [server/server.js](server/server.js). It supports chat and tracking rooms, but the event flow is not fully persisted or authorized.
- Deployment config: no production deployment manifest or CI/CD pipeline was found in the repo. The server is configured as a Node.js process with environment variables from [server/.env.example](server/.env.example), and the app is designed for a standard Node + PostgreSQL deployment, not an automated container build.

## 2) Verified baseline checks

The following checks were run from [server/package.json](server/package.json):

| Check | Result | Evidence |
|---|---|---|
| npm install | Passed | Dependencies installed successfully; 8 vulnerabilities reported by npm audit. |
| npx prisma validate | Passed | Prisma schema load was valid and accepted by the CLI. |
| npx prisma generate | Passed | Prisma Client generated successfully in server/node_modules. |
| npm run db:check | Passed | Connected to PostgreSQL successfully; schema showed 21 tables in public. |
| node tests/stage1-completion-security.test.js | Passed | Output: “Stage 1 security checks passed”. |
| npm start | Passed | Server started and logged: “LocalHire API server running on port 5000”. |
| Browser UI smoke test | Not run | No browser automation or production build pipeline was available in the current workspace. |
| Production build / deployment bundle | Not run | No frontend framework build or deployment config was present. |

Notes:

- The Prisma database connection succeeded against a remote PostgreSQL instance using a sanitized connection string. No secret value is included here.
- The project does not contain a committed active .env file. Only [server/.env.example](server/.env.example) is tracked, which is correct for a secret-safe repository.
- The repo still contains legacy MongoDB references and a mixed fallback pattern in the frontend. The runtime is PostgreSQL-backed, but the user experience is not yet fully aligned with that persistence model.

## 3) Verified issues and risks

### Issue 1 — Role escalation during registration

- Priority: P0
- Affected file or module: [server/controllers/authController.js](server/controllers/authController.js)
- Observed problem and supporting evidence: The registration endpoint accepts a role from the request body, normalizes it through a trusted map, and creates the user with that role. This allows a client to self-assign ADMIN by sending a crafted role value.
- User-facing impact: A malicious or careless user can escalate to Admin privileges, view protected data, manage bookings, or override moderation workflows.
- Proposed fix: Restrict registration to CUSTOMER and WORKER only, remove role assignment from client input, and require admin-only creation flows for ADMIN accounts.
- Test needed to verify the fix: Add an automated auth test asserting that registering with role ADMIN is rejected and that only server-side admin creation paths can produce an ADMIN account.

### Issue 2 — LocalStorage fallback stores plaintext user credentials and live mock state

- Priority: P0
- Affected file or module: [js/api.js](js/api.js), [js/data.js](js/data.js), [js/app.js](js/app.js)
- Observed problem and supporting evidence: The API client falls back to localStorage when the backend is unavailable and the local mock app writes user objects and session data to browser storage. The mock data includes password values and session tokens are cached in plaintext in the browser.
- User-facing impact: Anyone with browser access or a compromised browser extension can recover credentials or impersonate a user. This is a severe security issue for a production marketplace.
- Proposed fix: Remove all sensitive localStorage fallback writes for auth/session and user data. Fail closed with a clear error state instead of writing mock credentials to the browser.
- Test needed to verify the fix: Add a browser-level test that confirms login/register failures do not create persisted auth objects or writable user records in localStorage.

### Issue 3 — Logout does not revoke JWT/session consistently

- Priority: P0
- Affected file or module: [js/app.js](js/app.js), [server/middlewares/authMiddleware.js](server/middlewares/authMiddleware.js)
- Observed problem and supporting evidence: The logout helper clears only the session object and does not ensure all token storage is removed. The auth middleware accepts bearer tokens but there is no explicit server-side revoke mechanism or secure cookie invalidation path.
- User-facing impact: Shared or compromised devices can retain active sessions and continue using stale JWTs after a user logs out.
- Proposed fix: Clear all client-side auth keys, invalidate server-side refresh/session state if used, and switch to secure HTTP-only cookies for JWT delivery where feasible.
- Test needed to verify the fix: Create a test that logs in, logs out, and confirms the next authenticated request is rejected and no token remains in browser storage.

### Issue 4 — Frontend and backend are still split-brain and disconnected from live data

- Priority: P1
- Affected file or module: [js/api.js](js/api.js), [pages/admin.html](pages/admin.html), [pages/edit-profile.html](pages/edit-profile.html), [pages/profile.html](pages/profile.html), [pages/my-jobs.html](pages/my-jobs.html)
- Observed problem and supporting evidence: Several pages do not load the API client or rely on localStorage fallback. The admin page reads mock data from localStorage, and my-jobs relies on stale patterns rather than the real booking model. This is persistent evidence of a split-brain app state.
- User-facing impact: Users see different data depending on page behavior, some pages silently fall back to stale mock state, and important flows like worker profiles or admin moderation no longer reflect the real backend.
- Proposed fix: Standardize the client on the API layer, remove localStorage write fallback for account-critical features, and ensure every production page loads the same API client and error states.
- Test needed to verify the fix: Browser smoke tests that load each critical page with the backend available and confirm the page fetches live data instead of mock arrays.

### Issue 5 — Booking lifecycle and transition rules are incomplete in the real app flow

- Priority: P1
- Affected file or module: [server/controllers/bookingController.js](server/controllers/bookingController.js), [server/tests/stage1-completion-security.test.js](server/tests/stage1-completion-security.test.js)
- Observed problem and supporting evidence: The booking controller has a status transition helper and a stage1 test confirms the essential role restrictions for worker/customer transition flows. However, the UI still uses a broad set of booking states and the controller relies on manual status checks without a full state machine validation for all edges (e.g., cancellation, dispute, completion, and release verification). The repo does not yet exercise the end-to-end booking flow fully.
- User-facing impact: Bookings can be created and updated, but edge-case transitions can still be inconsistent between the UI and backend. This can lead to duplicate completion, invalid cancellations, or a mismatch between the booking status and escrow release state.
- Proposed fix: Complete the server-side booking state machine, enforce consistent transitions and ownership checks, and add a full end-to-end booking test that covers REQUESTED → CONFIRMED → IN_PROGRESS → AWAITING_CUSTOMER_CONFIRMATION → COMPLETED.
- Test needed to verify the fix: API integration test covering the full booking flow and ensuring status changes are rejected outside the allowed transition graph.

### Issue 6 — Chat is not yet a reliable persistent real-time system

- Priority: P1
- Affected file or module: [server/server.js](server/server.js), [server/controllers/chatController.js](server/controllers/chatController.js), [pages/chat.html](pages/chat.html)
- Observed problem and supporting evidence: Socket.IO auth is enabled, but server-side chat messages are broadcast without being persisted to the database by the socket event itself. The REST sendMessage route persists messages, but it does not emit them to a room. The client also has no authentic thread history feed and relies on browser state.
- User-facing impact: Users can send a message in the browser, but it may not be stored consistently or visible across sessions; real-time chat becomes unreliable and easy to lose.
- Proposed fix: Persist every socket message through Prisma, emit the saved record back to the room, and ensure the conversation list loads from the database for the current user.
- Test needed to verify the fix: Integration test that sends a message over Socket.IO, confirms the message is inserted into the database, and then verifies both users receive the saved message payload.

### Issue 7 — Escrow and payment flow is still a frontend simulation, not a production payment flow

- Priority: P1
- Affected file or module: [js/escrow.js](js/escrow.js), [server/controllers/escrowController.js](server/controllers/escrowController.js)
- Observed problem and supporting evidence: The frontend escrow modal simulates payment and localStorage writes. The controller exists but is not connected to a real gateway and does not verify payment webhooks or release steps outside the browser simulation. This is a mock financial flow rather than a production payment flow.
- User-facing impact: Customers cannot rely on escrow as a real payment lock and release mechanism, and workers have no production-grade financial settlement guarantee.
- Proposed fix: Integrate a real payment provider (Razorpay, Stripe, or equivalent) with server-side webhook verification and a production-safe sandbox mode for staging.
- Test needed to verify the fix: Payment flow test covering escrow creation, webhook validation, and release authorization with a sandbox provider.

### Issue 8 — Admin dashboard is operationally disconnected from real platform data

- Priority: P2
- Affected file or module: [pages/admin.html](pages/admin.html), [server/controllers/adminController.js](server/controllers/adminController.js)
- Observed problem and supporting evidence: The admin page pulls values from localStorage and uses hard-coded static metrics such as “₹12,450” and alert-based actions. The controller is present but not wired to live moderation and metrics for the actual PostgreSQL backend.
- User-facing impact: Administrators cannot trust moderation, user verification, or platform revenue data. The feature is effectively a mock dashboard and not production-grade.
- Proposed fix: Connect admin API endpoints to live Prisma aggregations, replace alert actions with server-backed verification, moderation, and escalation flows, and enforce server-side admin checks.
- Test needed to verify the fix: Admin dashboard integration test verifying role enforcement and real metrics loads for authorized users only.

### Issue 9 — Mixed persistence model and legacy notes are still present in the project

- Priority: P2
- Affected file or module: [server/package.json](server/package.json), [server/config/db.js](server/config/db.js), [server/models](server/models), [MIGRATION_STRATEGY.md](MIGRATION_STRATEGY.md)
- Observed problem and supporting evidence: The repo still ships Mongoose dependencies and a legacy MongoDB connection helper even though the active DB check and schema are PostgreSQL/Prisma. This means the project is in a migration state that can confuse both engineers and deployment automation.
- User-facing impact: Deployment drift and confusion during maintenance; a developer can mistakenly assume MongoDB is still active when the real system uses PostgreSQL.
- Proposed fix: Remove or clearly quarantine legacy MongoDB code paths and standardize the server and docs on the PostgreSQL/Prisma architecture before production cutover.
- Test needed to verify the fix: A repo-level validation that all runtime scripts reference Prisma/PostgreSQL paths and that no startup path relies on MongoDB connection logic.

## 4) Findings by subsystem

### Authentication and authorization

- JWT auth is present and working at the backend layer.
- The registration path still allows privilege escalation by accepting client role input.
- Logout and client-side session clearing are insufficient for production.
- The server currently lacks a robust, production-safe token strategy for cookies and revocation.

### Database and migration state

- Prisma schema is valid and the database is reachable.
- The repo successfully connected to a PostgreSQL database via Prisma.
- The application is not fully migrated away from MongoDB-era assumptions, but the real code path is DB-backed by PostgreSQL.

### Booking workflow

- Booking creation and booking status checks exist in the backend.
- The stage1 security test passes for the direct state transition checks.
- The full end-to-end flow is not yet validated across all customer/worker/admin transitions, especially cancellation, completion confirmation, and escrow release timing.

### Chat, GPS, payment, and admin

- Socket.IO exists and is authenticated.
- GPS tracking events are implemented, but they are not tied to a complete booking/location verification and persistence story.
- Escrow and admin flows are still mock-heavy and not ready for production finance or moderation operations.

## 5) Production-readiness verdict

The project is not deployment-ready tonight as a production marketplace. The environment is moving in the right direction, the Prisma/PostgreSQL base is valid, and the server can start successfully, but the security posture, user data flow, and payment/admin workflows still contain critical gaps.

The most important immediate constraints are:

1. Remove client-controlled role assignment and plaintext localStorage auth persistence.
2. Align the frontend with live Prisma/PostgreSQL-backed flows instead of local fallback data.
3. Finish the end-to-end booking and chat persistence model.
4. Replace mock escrow/admin flows with real server-side verification and payment integration.

## 6) This is the minimum acceptable path before deployment

- Harden auth and session handling.
- Standardize all critical pages on the backend API and eliminate localStorage writes for user-sensitive data.
- Complete the booking lifecycle and server-side authorization checks.
- Make chat persist and sync over Socket.IO without data loss.
- Add real payment provider integration and admin moderation hooks.
- Prove the application with integration tests before enabling production traffic.
