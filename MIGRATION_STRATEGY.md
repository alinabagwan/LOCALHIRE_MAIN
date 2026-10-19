# LocalHire — Architecture Migration Strategy: MongoDB & LocalStorage to PostgreSQL

This document outlines the systematic, zero-downtime engineering strategy to transition **LocalHire** from its current hybrid MongoDB/LocalStorage architecture to an enterprise PostgreSQL & Prisma relational foundation.

---

## 1. Current State vs. Target Architecture

```
CURRENT HYBRID STATE (High Risk & Inconsistent):
[Browser UI] ──┬──(HTTP Fetch)──> [Express API] ──> [MongoDB / Mongoose (Single Node)]
               └──(Fallback)────> [Browser LocalStorage (Isolated per device, Plaintext)]

TARGET RELATIONAL STATE (Production-Grade & ACID Compliant):
[Browser UI] ───(HTTP / WSS with JWT)───> [Express API + Prisma ORM] ───> [PostgreSQL Database]
```

### Key Differences & Incompatibilities Addressed
1. **Primary Keys:** MongoDB uses 24-character hexadecimal `ObjectId`s (e.g., `6a71ebe8...`); the new schema uses standard RFC 4122 `UUIDv4` strings (e.g., `c234a980-b21a-4d2b-b6d8-9df8b1e56a70`).
2. **Geospatial Queries:** MongoDB uses GeoJSON `Point` objects with `2dsphere` indexes (`$near`); PostgreSQL uses standard latitude/longitude floats with indexed coordinate pairs or PostGIS extension for spherical distance.
3. **Data Integrity:** MongoDB allowed unformatted strings for money (`"₹400 - ₹600"`); PostgreSQL enforces strict `Decimal(10, 2)` monetary values with exact two-decimal precision.
4. **Relational Constraints:** LocalStorage and MongoDB allowed orphan records (e.g., a review or quote referencing a non-existent job); PostgreSQL enforces referential integrity via explicit foreign keys and `onDelete` cascades/restrictions.

---

## 2. Safety & Non-Breaking Guarantee

To ensure safety and project stability:
* **Zero Deletion Policy:** No existing Mongoose models (`server/models/User.js`, `Job.js`, etc.) have been deleted.
* **Backward Compatibility:** Legacy routes continue to run as before until each controller is individually upgraded and verified.
* **Environment Independence:** The project does not require a local PostgreSQL instance to compile, run tests, or start the server. If `DATABASE_URL` is omitted, clear diagnostic messages are emitted without crashing unrelated workflows.

---

## 3. Migration Roadmap & Conversion Checkpoints

### Step 1: Foundation (COMPLETED)
- [x] Prisma ORM and PostgreSQL driver installed and validated.
- [x] Production schema designed in `server/prisma/schema.prisma` covering all home service trades.
- [x] Initial SQL DDL migration committed to `server/prisma/migrations/20261018000000_init/migration.sql`.
- [x] Fictional development seed script created in `server/prisma/seed.js`.
- [x] Connectivity verification utility created in `server/scripts/check-db.js`.
- [x] Data importer utility created in `server/scripts/import-from-mongodb.js`.
- [x] Setup documentation created for the target database host in `DATABASE_SETUP.md`.

### Step 2: Controller Conversion (NEXT PHASE)
Each backend controller will be migrated in isolation:
1. **`authController.js`:**
   - Replace `User.findOne({ email })` with `prisma.user.findUnique({ where: { email } })`.
   - Prevent role tampering during registration.
   - Return standard JWT with user UUID.
2. **`userController.js`:**
   - Query `prisma.workerProfile.findMany` with category, rating, and bounding-box latitude/longitude filters.
   - Sanitize profile updates using explicit field pick lists (eliminate Mass Assignment).
3. **`jobController.js` & `appController.js`:**
   - Migrate job postings and quotes to `prisma.jobPost` and `prisma.jobApplication`.
   - Use atomic Prisma transactions (`prisma.$transaction`) when accepting quotes and creating bookings.
4. **`escrowController.js`:**
   - Link `prisma.escrowPayment` directly to `prisma.booking`.
   - Prepare webhook verification endpoint for payment gateways (e.g. Razorpay).
5. **`chatController.js` & `server.js` Socket Gateway:**
   - Synchronize Socket.IO room broadcasts with `prisma.chatMessage.create`.

### Step 3: Frontend API Realignment (ELIMINATING LOCALSTORAGE SPLIT-BRAIN)
1. **Include `api.js` on Orphaned Pages:**
   - Add `<script src="../js/api.js"></script>` to `pages/admin.html`, `pages/edit-profile.html`, and `pages/profile.html`.
2. **Decommission Fallback Writes:**
   - Remove `window.localHireApp.saveJob()`, `saveApplication()`, and `registerUser()` fallback writes that store data in `localStorage`.
   - In offline situations, render standard error state messages rather than corrupting state in `localStorage`.
3. **Fix ID Matching in `my-jobs.html`:**
   - Replace string matching (`j.customerName === user.name`) with relational UUID checks (`j.customerId === user.id`).

### Step 4: MongoDB Data Import & Verification
When the PostgreSQL database is live on the friend's laptop:
1. Run a dry run to verify data mapping:
   ```bash
   node scripts/import-from-mongodb.js --dry-run
   ```
2. Inspect the reconciliation report (mapped users, converted budget ranges, categories).
3. Run the live import:
   ```bash
   node scripts/import-from-mongodb.js --execute
   ```
4. Verify record counts using `npm run db:check` or Prisma Studio (`npx prisma studio`).

### Step 5: Full Cutover & Legacy Deprecation
Only after Steps 1–4 have been thoroughly tested:
1. Remove `mongoose` from `server/package.json`.
2. Remove `server/models/` directory.
3. Remove legacy fallback methods in `js/data.js`.
4. Update the primary README with PostgreSQL production documentation.
