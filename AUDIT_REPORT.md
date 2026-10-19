# LocalHire: Comprehensive Architectural, Security & Codebase Audit Report

**Date:** October 18, 2026  
**Auditor:** Senior Full-Stack Developer & Software Architect  
**Project:** LocalHire — Production-Oriented Local Home-Services Marketplace  
**Scope:** Complete Frontend, Backend API, Data Models, Authentication, Real-Time Chat, Reviews, Admin Dashboard, Escrow/Payments, Security & Storage Dependencies.

---

## 1. Executive Summary & Marketplace Vision Alignment

The objective of **LocalHire** is to transition from an early prototype/academic project into a **production-grade, multi-category local home-services marketplace** (covering electricians, plumbers, cleaners, carpenters, AC technicians, appliance repair, painters, pest control, and handymen). 

### Current State Assessment
The existing codebase is in a **hybrid "split-brain" state**:
1. **Frontend-Backend Disconnection:** A subset of pages communicates with an Express/MongoDB backend via an API abstraction layer (`js/api.js`), but whenever any request fails, the client silently falls back to browser `localStorage`.
2. **Orphaned Pages:** Several critical views (`pages/admin.html`, `pages/edit-profile.html`, `pages/profile.html`) do not even load `js/api.js`. They read and write exclusively to browser `localStorage` using static mock arrays in `js/data.js`.
3. **Broken Real-Time Loop:** Socket.IO handles live chat broadcasts in memory without authentication, while REST API endpoints write chat messages to MongoDB without broadcasting to Socket.IO. As a consequence, messages are either lost on refresh or never seen live.
4. **Simulated Payments:** The "Escrow" payment system is 100% mocked on the frontend with simulated UPI/Card modal dialogs and has zero integration with real payment gateways (e.g., Razorpay, Stripe, Cashfree).
5. **Database Infrastructure:** Currently configured exclusively for MongoDB/Mongoose with hardcoded DNS overrides and mandatory TLS flags that crash in local non-TLS development environments. No PostgreSQL or Prisma dependencies currently exist.

---

## 2. Granular Feature Status Matrix

| Component / Feature | Classification | Technical Finding & Current Reality |
| :--- | :--- | :--- |
| **Glassmorphism Design System** | **Working** | CSS variables, typography, and responsive grid layouts in `css/style.css` and `css/escrow.css` render consistently across devices. |
| **Geolocation & Interactive Map** | **Working** | Leaflet.js integration on `index.html` and `pages/search.html` successfully captures browser GPS coordinates and renders map pins. |
| **Search & Filtering UI** | **Working** | Keyword input, category dropdown, and price range sliders function correctly in the browser DOM. |
| **Mongoose Data Models** | **Working (Legacy)** | `User.js`, `Job.js`, `Application.js`, `Review.js`, `Message.js`, and `EscrowTransaction.js` define schema structures, but rely on MongoDB-specific features (e.g. `2dsphere` indexes). |
| **User Registration & Login** | **Partial / Insecure** | Works against MongoDB when the server is running, but allows client-controlled privilege escalation (`role: "Admin"`), stores plaintext passwords in `localStorage` fallback, and fails to revoke JWT on logout. |
| **Worker Profile Management** | **Broken / Mocked** | `pages/edit-profile.html` does not load `api.js` and saves solely to `localStorage`. Profile changes never reach the database. `PUT /api/users/profile` in the backend suffers from unrestricted Mass Assignment. |
| **Job Request Creation** | **Partial** | Jobs can be saved via API, but budget is stored as an unformatted String (`"₹400 - ₹600"`), preventing numerical queries, validation, or programmatic escrow calculations. |
| **Worker Job Feed & Bidding** | **Partial** | Workers can view open jobs and submit quotes. However, customer view in `pages/my-jobs.html` attempts to read applications from `localStorage`, causing worker IDs to default to `'w1'` and budgets to `'500'`. |
| **Escrow & Milestone Payments** | **Mocked / Partial** | Backend maintains `EscrowTransaction` records with states (`Escrow_Held`, `Released`, `Disputed`), but frontend payment modal is entirely simulated with zero payment gateway SDKs or webhook verification. |
| **Real-Time Chat** | **Broken / Insecure** | Socket.IO server is unauthenticated. Live messages in `pages/chat.html` are never saved to the database. Sidebar conversations list is empty/hardcoded. |
| **Worker Reviews & Ratings** | **Mocked / Insecure** | Backend `POST /api/reviews` has no check ensuring the reviewer actually booked or completed the job (IDOR/Review bombing). `pages/profile.html` displays hardcoded static reviews. |
| **Admin Dashboard** | **Mocked / Broken** | `pages/admin.html` does not import `api.js`. Metric cards have hardcoded revenue (`₹12,450`), and "Verify" / "Flag" buttons trigger dummy browser `alert()` popups. |
| **Session & Token Invalidation** | **Broken** | `window.handleLogout()` only removes `localHire_session` from `localStorage`, leaving `localHire_token` active indefinitely. |

---

## 3. Comprehensive Deep-Dive Audit by Subsystem

### 3.1. Authentication, Authorization & Session Management
* **Vulnerability — Unrestricted Role Assignment (Privilege Escalation):**  
  In `server/controllers/authController.js` (lines 16–31), the `register` function extracts `role` directly from `req.body` without role authorization:
  ```javascript
  const user = await User.create({ name, email, password, role: role || 'Customer', ... });
  ```
  Any malicious actor can send `{"role": "Admin"}` during registration and gain full administrative privileges.
* **Vulnerability — Mass Assignment in Profile Updates:**  
  In `server/controllers/userController.js` (lines 81–99), `updateProfile` performs:
  ```javascript
  const fieldsToUpdate = { ...req.body };
  const user = await User.findByIdAndUpdate(req.user.id, fieldsToUpdate, { new: true, runValidators: true });
  ```
  A regular user can update their own `role` to `Admin`, arbitrarily increase their `rating`, or modify sensitive internal flags.
* **Vulnerability — Unchecked User Deletion in Middleware:**  
  In `server/middlewares/authMiddleware.js` (lines 14–15):
  ```javascript
  req.user = await User.findById(decoded.id).select('-password');
  return next();
  ```
  If a user has been deleted or deactivated in the database after their JWT was issued, `req.user` is `null`, but `protect` still calls `next()`. Downstream controllers crash with unhandled `TypeError: Cannot read properties of null (reading '_id')`.
* **Vulnerability — Insecure Client-Side LocalStorage Fallback:**  
  In `js/data.js` (lines 225–252), when the backend is offline, registration saves the user object—including plaintext passwords—directly into `localStorage.getItem('localHire_users')`. Any script or browser extension with access to `localStorage` can harvest user credentials.
* **Vulnerability — Leaked JWT on Logout:**  
  In `js/app.js` (lines 204–207), `window.handleLogout` calls `localHireApp.logoutUser()`, which only removes `localHire_session`. The JWT in `localHire_token` is never deleted, leading to session persistence across accounts on shared computers.

### 3.2. Booking Workflow & Object-Level Authorization (BOLA/IDOR)
* **Vulnerability — Unauthorized Job Status & Assignment Override:**  
  In `server/controllers/jobController.js` (`updateJobStatus`, lines 118–135), the endpoint verifies authentication (`protect`), but does **not** verify that `req.user.id === job.customer.toString()` or that the user is an Admin. Any authenticated worker or customer can change the status of any job or reassign workers.
* **Vulnerability — Competitor Quote Disclosure:**  
  In `server/routes/appRoutes.js` (line 8), `GET /api/applications/job/:jobId` is protected only by general authentication. Any logged-in worker can query this endpoint and inspect all competing quotes, pricing proposals, and private messages submitted by other workers.
* **Vulnerability — Unauthorized Quote Acceptance:**  
  In `server/controllers/appController.js` (`acceptQuote`, lines 116–136), there is no verification that the authenticated user owns the job associated with the application.
* **Architectural Flaw — String-Based Budgeting:**  
  The `Job` schema defines `budget: { type: String }` (e.g. `"₹400 - ₹600"`). This prevents database-level range queries, currency conversions, platform fee calculations, and automated escrow deposit amounts.

### 3.3. Real-Time Chat & Messaging Architecture
* **Unauthenticated WebSocket Gateway:**  
  In `server/server.js` (lines 41–57), the Socket.IO server allows unauthenticated socket connections. Any client can emit `join_room` with an arbitrary string and intercept messages or spoof `send_message`.
* **Database & Socket Decoupling:**  
  - When `pages/chat.html` sends a message, it emits a socket event `socket.emit('send_message', ...)` and completely bypasses the backend API `POST /api/chat/messages`. The message is never saved to the database.
  - When `POST /api/chat/messages` is called via REST, it persists to MongoDB but never emits to Socket.IO.
* **Hardcoded Demo State:**  
  `pages/chat.html` renders a hardcoded fake message (`"Hello! Welcome to LocalHire direct messaging..."`) and has no active inbox or thread history listing.

### 3.4. Escrow & Payment Processing
* **Simulated Financial Transactions:**  
  `js/escrow.js` opens a modal simulating UPI and Card payments. While the backend has an `EscrowTransaction` model, it is purely a state tracker without a payment gateway integration (Razorpay / Stripe / Cashfree), webhook signature verification, or banking ledger reconciliation.
* **Client-Side ID Desynchronization:**  
  In `pages/my-jobs.html` (lines 267–272), when a customer accepts a quote, the script executes:
  ```javascript
  const apps = window.localHireApp.getApplications();
  const app = apps.find(a => a.id === appId);
  const workerId = app ? app.workerId : 'w1';
  const amountStr = app ? app.quote.replace(/[^0-9]/g, '') : '500';
  ```
  If applications came from the backend, `window.localHireApp.getApplications()` is empty, causing the system to fallback to a fake worker ID (`'w1'`) and arbitrary amount (`500`).

### 3.5. Reviews, Ratings & Reputation System
* **Unverified Reviews & Rating Manipulation:**  
  In `server/controllers/reviewController.js` (`createReview`, lines 7–33), any authenticated user can submit a review for any worker. The backend does not verify:
  1. Whether a booking or job exists between the customer and worker.
  2. Whether the job status is `'Completed'`.
  3. Whether the customer has already reviewed this job (no composite unique index on `[job, customer]`).
* **Hardcoded Profile Reviews:**  
  In `pages/profile.html` (lines 80–98), reviews are static HTML strings ("Excellent service!", "2 weeks ago") that never load from the database or API.

### 3.6. Server Infrastructure & Database Connection
* **Fragile Connection Strategy in `server/config/db.js`:**  
  - Overrides system DNS with `dns.setServers(['8.8.8.8', '8.8.4.4'])`, which fails in enterprise, institutional, or restricted DNS environments.
  - Hardcodes `tls: true` inside Mongoose connection options, preventing developers from connecting to standard local MongoDB instances (`mongodb://localhost:27017`).
  - Aborts server boot (`process.exit(1)`) if MongoDB is unreachable, preventing offline frontend development or decoupling API health checks.
* **Development Artifacts in Server:**  
  `server/tmp-escrow-debug.js` contains developer test code with hardcoded user emails (`alinbagwan@gmail.com`) and static database ObjectIDs.

---

## 4. File-by-File Recommendations (Without Deletions)

| File Path | Action | Rationale & Required Modifications |
| :--- | :--- | :--- |
| `server/server.js` | **Modify** | Add JWT handshake to Socket.IO; configure CORS for production domain whitelist; decouple startup from fatal database crash; mount Prisma client. |
| `server/config/db.js` | **Deprecate / Replace** | Replace MongoDB connection logic with Prisma Client singleton (`prisma.js`). Retain legacy file until full migration is verified. |
| `server/package.json` | **Modify** | Add `@prisma/client`, `prisma` (dev), `zod` (validation), `helmet`, `cookie-parser`; remove `mongoose`. |
| `server/models/*.js` (All models) | **Retain temporarily -> Deprecate** | Keep as reference for schema migration; will be superseded by `prisma/schema.prisma`. |
| `server/controllers/authController.js` | **Modify** | Enforce role whitelisting (prevent self-assigned Admin); implement refresh tokens in HTTP-only cookies; add Zod input validation. |
| `server/controllers/userController.js` | **Modify** | Replace Mass Assignment in `updateProfile` with explicit field picking; sanitize search queries against SQL injection via Prisma. |
| `server/controllers/jobController.js` | **Modify** | Add BOLA/IDOR checks (only owner or admin can update status); convert budget to numerical ranges; enforce status state machine. |
| `server/controllers/appController.js` | **Modify** | Restrict application visibility to job owner and submitting worker; wrap quote acceptance and worker assignment in a Prisma transaction. |
| `server/controllers/chatController.js` | **Modify** | Connect REST message creation with Socket.IO emitter (`io.to(roomId).emit`); add conversation list endpoint. |
| `server/controllers/reviewController.js` | **Modify** | Require completed booking validation before allowing a review; implement composite unique constraint to prevent duplicate reviews. |
| `server/controllers/adminController.js` | **Modify** | Replace in-memory metrics with efficient SQL aggregations; add real user verification, account suspension, and dispute resolution logic. |
| `server/controllers/escrowController.js` | **Modify** | Integrate webhook handlers and order creation with a real payment gateway (e.g. Razorpay / Stripe); implement audit logs. |
| `server/middlewares/authMiddleware.js` | **Modify** | Handle null user checks; verify token expiration; read token from HTTP-only cookie as well as Authorization header. |
| `server/tmp-escrow-debug.js` | **Retain (Move to scratch)** | Scratch testing script containing personal email; remove from production paths. |
| `js/api.js` | **Modify** | Remove silent `localStorage` fallback; standardize error handling and loading indicators; add authentication refresh interceptor. |
| `js/data.js` | **Deprecate / Retain for Seed** | Stop storing live user data and plaintext passwords in `localStorage`. Convert mock data into Prisma seed script. |
| `js/app.js` | **Modify** | Ensure `logoutUser` thoroughly clears tokens, session cookies, and cached profile state; escape HTML in rendering functions to prevent XSS. |
| `js/escrow.js` | **Modify** | Replace mock payment method selector with real payment gateway checkout SDK (e.g. Razorpay modal). |
| `pages/admin.html` | **Modify** | Include `api.js`; implement client-side and server-side Admin role guard; connect metrics and moderation tables to live API. |
| `pages/edit-profile.html` | **Modify** | Include `api.js`; send profile updates to `PUT /api/users/profile` instead of local storage; support home-service categories. |
| `pages/profile.html` | **Modify** | Include `api.js`; fetch worker profile, real reviews, and verified badges dynamically from backend API; add review submission modal. |
| `pages/chat.html` | **Modify** | Authenticate socket connection with JWT; render live thread history from database; implement dynamic conversations sidebar. |
| `pages/my-jobs.html` | **Modify** | Remove string matching on customer name; use unique relational foreign keys (`customerId`, `workerId`); handle real quote acceptance. |
| `pages/post-job.html` | **Modify** | Expand form to include service address, scheduled date/time slot, urgency, and numeric budget ranges. |
| `pages/search.html` | **Modify** | Add category filters for all home-services (Electrician, Plumber, Cleaner, Carpenter, AC Tech, Appliance, Painter, Pest Control). |

---

## 5. PostgreSQL & Prisma Database Migration Blueprint

### 5.1. Database Architecture & Environment Strategy
* **Remote Host Configuration:** Since PostgreSQL is hosted on your friend's laptop, the client codebase will connect via a standardized connection URI (`DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/localhire_db?schema=public`).
* **Zero Local Dependency:** The local development environment will **not** attempt to establish a database connection during static code analysis, audits, or build checks.
* **Migration Strategy:** The schema will be managed via Prisma schema definitions (`prisma/schema.prisma`) and applied using `prisma migrate dev` or `prisma db push` on the friend's laptop.

### 5.2. Proposed Production Prisma Schema (`schema.prisma`)

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// -------------------------------------------------------------
// ENUMS
// -------------------------------------------------------------

enum UserRole {
  CUSTOMER
  WORKER
  ADMIN
}

enum JobStatus {
  OPEN
  QUOTED
  ASSIGNED
  IN_PROGRESS
  COMPLETED
  CANCELLED
  DISPUTED
}

enum ApplicationStatus {
  PENDING
  ACCEPTED
  REJECTED
  WITHDRAWN
}

enum EscrowStatus {
  HELD
  RELEASED
  REFUNDED
  DISPUTED
}

enum PaymentMethod {
  UPI
  CARD
  NET_BANKING
  CASH_ON_SERVICE
}

enum UrgencyLevel {
  EMERGENCY_TODAY
  THIS_WEEK
  FLEXIBLE
}

enum PriceType {
  FIXED
  HOURLY
  INSPECTION_PLUS_QUOTE
}

// -------------------------------------------------------------
// USER & PROFILE MODELS
// -------------------------------------------------------------

model User {
  id              String           @id @default(uuid())
  email           String           @unique
  passwordHash    String
  name            String
  phone           String?
  role            UserRole         @default(CUSTOMER)
  avatarUrl       String?
  isActive        Boolean          @default(true)
  isVerified      Boolean          @default(false)
  createdAt       DateTime         @default(now())
  updatedAt       DateTime         @updatedAt

  // Relational Profiles
  workerProfile   WorkerProfile?
  addresses       CustomerAddress[]
  
  // Job & Booking Relations
  jobsPosted      JobPost[]        @relation("CustomerJobs")
  applications    JobApplication[] @relation("WorkerApplications")
  jobsAssigned    JobPost[]        @relation("WorkerAssignedJobs")
  
  // Financial Relations
  escrowsPaid     EscrowPayment[]  @relation("CustomerEscrows")
  escrowsReceived EscrowPayment[]  @relation("WorkerEscrows")
  
  // Feedback & Communication
  reviewsGiven    Review[]         @relation("CustomerReviews")
  reviewsReceived Review[]         @relation("WorkerReviews")
  sentMessages    ChatMessage[]    @relation("SentMessages")
  recvMessages    ChatMessage[]    @relation("ReceivedMessages")
  disputesRaised  Dispute[]        @relation("DisputesRaised")
  auditLogs       AuditLog[]

  @@index([email])
  @@index([role])
}

model WorkerProfile {
  id                  String          @id @default(uuid())
  userId              String          @unique
  user                User            @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  categoryId          String
  category            ServiceCategory @relation(fields: [categoryId], references: [id])
  
  subCategory         String?
  experienceYears     Int             @default(0)
  hourlyRate          Decimal         @default(0) @db.Decimal(10, 2)
  inspectionFee       Decimal         @default(0) @db.Decimal(10, 2)
  bio                 String?         @db.Text
  availabilityStatus  String          @default("Available Today")
  
  isBackgroundChecked Boolean         @default(false)
  isInsured           Boolean         @default(false)
  
  rating              Decimal         @default(5.0) @db.Decimal(3, 2)
  reviewsCount        Int             @default(0)
  serviceRadiusKm     Int             @default(20)
  
  // Location
  address             String?
  latitude            Float?
  longitude           Float?

  skills              WorkerSkill[]

  createdAt           DateTime        @default(now())
  updatedAt           DateTime        @updatedAt

  @@index([categoryId])
  @@index([latitude, longitude])
}

// -------------------------------------------------------------
// SERVICE TAXONOMY & CATALOG
// -------------------------------------------------------------

model ServiceCategory {
  id             String          @id @default(uuid())
  name           String          @unique // Electrician, Plumber, Cleaner, Carpenter, AC Tech, etc.
  slug           String          @unique
  description    String?
  iconUrl        String?
  isActive       Boolean         @default(true)
  
  workerProfiles WorkerProfile[]
  serviceItems   ServiceItem[]
  jobPosts       JobPost[]

  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt
}

model ServiceItem {
  id             String          @id @default(uuid())
  categoryId     String
  category       ServiceCategory @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  
  title          String          // E.g., "Ceiling Fan Installation", "Deep Kitchen Cleaning"
  description    String?
  basePrice      Decimal         @db.Decimal(10, 2)
  priceType      PriceType       @default(FIXED)
  durationMin    Int             @default(60)

  createdAt      DateTime        @default(now())
  updatedAt      DateTime        @updatedAt
}

model WorkerSkill {
  id              String        @id @default(uuid())
  workerProfileId String
  workerProfile   WorkerProfile @relation(fields: [workerProfileId], references: [id], onDelete: Cascade)
  skillName       String

  @@unique([workerProfileId, skillName])
}

// -------------------------------------------------------------
// CUSTOMER ADDRESSES
// -------------------------------------------------------------

model CustomerAddress {
  id          String    @id @default(uuid())
  customerId  String
  customer    User      @relation(fields: [customerId], references: [id], onDelete: Cascade)
  label       String    @default("Home") // Home, Office, Apartment
  street      String
  landmark    String?
  city        String
  postalCode  String
  latitude    Float?
  longitude   Float?
  isDefault   Boolean   @default(false)

  jobPosts    JobPost[]

  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt
}

// -------------------------------------------------------------
// JOB REQUESTS & APPLICATIONS
// -------------------------------------------------------------

model JobPost {
  id               String           @id @default(uuid())
  customerId       String
  customer         User             @relation("CustomerJobs", fields: [customerId], references: [id])
  
  categoryId       String
  category         ServiceCategory  @relation(fields: [categoryId], references: [id])
  
  addressId        String?
  address          CustomerAddress? @relation(fields: [addressId], references: [id])
  
  title            String
  description      String           @db.Text
  urgency          UrgencyLevel     @default(FLEXIBLE)
  scheduledDate    DateTime?
  scheduledSlot    String?          // E.g., "10:00 AM - 01:00 PM"
  
  budgetMin        Decimal?         @db.Decimal(10, 2)
  budgetMax        Decimal?         @db.Decimal(10, 2)
  status           JobStatus        @default(OPEN)
  
  assignedWorkerId String?
  assignedWorker   User?            @relation("WorkerAssignedJobs", fields: [assignedWorkerId], references: [id])

  applications     JobApplication[]
  escrowPayment    EscrowPayment?
  reviews          Review[]
  chatMessages     ChatMessage[]
  disputes         Dispute[]

  createdAt        DateTime         @default(now())
  updatedAt        DateTime         @updatedAt

  @@index([customerId])
  @@index([assignedWorkerId])
  @@index([categoryId])
  @@index([status])
}

model JobApplication {
  id            String            @id @default(uuid())
  jobId         String
  job           JobPost           @relation(fields: [jobId], references: [id], onDelete: Cascade)
  
  workerId      String
  worker        User              @relation("WorkerApplications", fields: [workerId], references: [id])
  
  quoteAmount   Decimal           @db.Decimal(10, 2)
  coverMessage  String            @db.Text
  status        ApplicationStatus @default(PENDING)

  createdAt     DateTime          @default(now())
  updatedAt     DateTime          @updatedAt

  @@unique([jobId, workerId])
  @@index([jobId])
  @@index([workerId])
}

// -------------------------------------------------------------
// PAYMENTS & ESCROW
// -------------------------------------------------------------

model EscrowPayment {
  id               String        @id @default(uuid())
  jobId            String        @unique
  job              JobPost       @relation(fields: [jobId], references: [id])
  
  customerId       String
  customer         User          @relation("CustomerEscrows", fields: [customerId], references: [id])
  
  workerId         String
  worker           User          @relation("WorkerEscrows", fields: [workerId], references: [id])
  
  totalAmount      Decimal       @db.Decimal(10, 2)
  platformFee      Decimal       @default(0) @db.Decimal(10, 2)
  workerPayout     Decimal       @db.Decimal(10, 2)
  currency         String        @default("INR")
  status           EscrowStatus  @default(HELD)
  
  paymentMethod    PaymentMethod @default(UPI)
  gatewayOrderId   String?       @unique
  gatewayPaymentId String?       @unique
  transactionRef   String        @unique
  
  releasedAt       DateTime?
  disputes         Dispute[]

  createdAt        DateTime      @default(now())
  updatedAt        DateTime      @updatedAt

  @@index([customerId])
  @@index([workerId])
  @@index([status])
}

// -------------------------------------------------------------
// REVIEWS & FEEDBACK
// -------------------------------------------------------------

model Review {
  id         String   @id @default(uuid())
  jobId      String
  job        JobPost  @relation(fields: [jobId], references: [id], onDelete: Cascade)
  
  customerId String
  customer   User     @relation("CustomerReviews", fields: [customerId], references: [id])
  
  workerId   String
  worker     User     @relation("WorkerReviews", fields: [workerId], references: [id])
  
  rating     Int      // 1 to 5
  comment    String   @db.Text

  createdAt  DateTime @default(now())
  updatedAt  DateTime @updatedAt

  @@unique([jobId, customerId, workerId])
  @@index([workerId])
}

// -------------------------------------------------------------
// REAL-TIME MESSAGING
// -------------------------------------------------------------

model ChatMessage {
  id         String   @id @default(uuid())
  senderId   String
  sender     User     @relation("SentMessages", fields: [senderId], references: [id])
  
  receiverId String
  receiver   User     @relation("ReceivedMessages", fields: [receiverId], references: [id])
  
  jobId      String?
  job        JobPost? @relation(fields: [jobId], references: [id], onDelete: SetNull)
  
  content    String   @db.Text
  isRead     Boolean  @default(false)

  createdAt  DateTime @default(now())

  @@index([senderId, receiverId])
  @@index([jobId])
}

// -------------------------------------------------------------
// DISPUTES & GOVERNANCE
// -------------------------------------------------------------

model Dispute {
  id              String         @id @default(uuid())
  escrowPaymentId String
  escrowPayment   EscrowPayment  @relation(fields: [escrowPaymentId], references: [id])
  
  jobId           String
  job             JobPost        @relation(fields: [jobId], references: [id])
  
  raisedById      String
  raisedBy        User           @relation("DisputesRaised", fields: [raisedById], references: [id])
  
  reason          String         @db.Text
  resolutionNotes String?        @db.Text
  isResolved      Boolean        @default(false)

  createdAt       DateTime       @default(now())
  updatedAt       DateTime       @updatedAt
}

model AuditLog {
  id        String   @id @default(uuid())
  userId    String?
  user      User?    @relation(fields: [userId], references: [id], onDelete: SetNull)
  action    String   // E.g., "ESCROW_RELEASED", "ROLE_UPDATED"
  details   Json?
  ipAddress String?
  createdAt DateTime @default(now())
}
```

---

## 6. Phased Implementation Plan

```mermaid
flowchart TD
    P1["Phase 1: DB & Prisma Migration (Remote PG)"] --> P2["Phase 2: Booking & Payment Workflow"]
    P2 --> P3["Phase 3: Frontend Refactor & Clean UI"]
    P3 --> P4["Phase 4: Real-Time Chat & AI Matching"]
    P4 --> P5["Phase 5: Security Hardening & Admin"]
    P5 --> P6["Phase 6: Testing & QA"]
    P6 --> P7["Phase 7: Production Deployment"]
```

### Phase 1: Database Migration & Clean Data Layer
* **Goals:** Configure Prisma ORM with remote PostgreSQL without touching local database drivers or halting existing development.
* **Key Tasks:**
  1. Initialize Prisma schema in `server/prisma/schema.prisma`.
  2. Configure `server/.env.example` with standard `DATABASE_URL` format.
  3. Create seed script (`server/prisma/seed.js`) covering the full spectrum of home services:
     - Categories: *Electrician, Plumber, Cleaner, Carpenter, AC Technician, Appliance Repair, Painter, Pest Control*.
     - Seed workers with realistic hourly rates, inspection fees, and skills.
  4. Implement `server/config/prisma.js` singleton client.
  5. Refactor controllers to use Prisma queries inside try/catch blocks with standard HTTP status codes.

### Phase 2: Booking Engine & Escrow Milestone Payments
* **Goals:** Replace simulated dummy modals with structured booking lifecycle and real payment gateway architecture.
* **Key Tasks:**
  1. Implement structured job status transitions: `OPEN` -> `QUOTED` -> `ASSIGNED` -> `IN_PROGRESS` -> `COMPLETED`.
  2. Numerical budget and quote handling (`Decimal` values, platform fee calculations).
  3. Integrated payment gateway controller (e.g. Razorpay / Stripe Order Creation & Webhook Verification).
  4. Two-factor job completion confirmation (e.g., Worker arrival PIN / Completion confirmation).

### Phase 3: Frontend Realignment & LocalStorage Decoupling
* **Goals:** Eradicate split-brain architecture and make the frontend 100% API-driven.
* **Key Tasks:**
  1. Add `js/api.js` script tags across all orphaned pages (`pages/admin.html`, `pages/edit-profile.html`, `pages/profile.html`).
  2. Remove `localStorage` fallback write operations for core entities (Users, Jobs, Applications, Messages).
  3. Implement standardized Toast notifications and error states instead of browser `alert()` popups.
  4. Fix `pages/my-jobs.html` to query jobs and quotes by foreign keys rather than customer names.

### Phase 4: Real-Time Communication & AI Smart Matching
* **Goals:** Bridge WebSockets with database persistence and introduce AI-driven provider recommendations.
* **Key Tasks:**
  1. Attach JWT authorization middleware to Socket.IO (`io.use(...)`).
  2. Synchronize REST message storage with WebSocket room emission so messages persist across sessions.
  3. Build active conversation threads list in `pages/chat.html`.
  4. **AI Smart Matching Service:** Implement an AI recommendation endpoint that matches customer job requirements (e.g., "Leaking pipe under kitchen sink") to worker skills, proximity, availability, and past customer ratings.

### Phase 5: Security Hardening & Admin Governance
* **Goals:** Eliminate OWASP Top 10 vulnerabilities (BOLA, IDOR, Mass Assignment, Privilege Escalation).
* **Key Tasks:**
  1. Whitelist allowed roles during registration (`Customer` and `Worker` only; `Admin` provisioned exclusively through secure seeding).
  2. Enforce object ownership checks on every mutating route (`job.customerId === req.user.id`).
  3. Whitelist updateable fields in profile updates using `zod` schemas.
  4. Implement HTTP-only, SameSite cookies for JWT storage to prevent token theft via XSS.
  5. Replace regex search queries with parameterized PostgreSQL `ILIKE` or Full-Text Search (`to_tsvector`).

### Phase 6: Automated Testing & Verification
* **Goals:** Ensure stability and verify all endpoints against edge cases without requiring a live local database.
* **Key Tasks:**
  1. Unit tests for validation schemas, authentication helpers, and distance calculation formulas using Jest / Vitest.
  2. Integration tests using mocked Prisma client (`jest-mock-extended` or `@prisma/client` mocks).
  3. End-to-end user journey tests for Job Posting -> Worker Quote -> Quote Acceptance -> Payment -> Completion.

### Phase 7: Production Deployment & Remote Orchestration
* **Goals:** Prepare for hosting frontend on static CDN (Vercel / Cloudflare Pages) and backend on cloud host (Render / Railway / AWS).
* **Key Tasks:**
  1. Set up Dockerfile and production start scripts.
  2. Configure environment variable templates with strict security policies.
  3. Establish database migration pipelines (`prisma migrate deploy`).

---

## 7. Exact Next Steps

1. **Step 1 (Friend's Laptop - PostgreSQL Setup):**
   * Friend installs PostgreSQL 15/16.
   * Friend creates database `localhire_db`.
   * Friend sets up a secure connection string and shares it securely (or configures a cloud database on Supabase / Neon for shared remote access).
2. **Step 2 (Local Machine - Prisma Configuration):**
   * Install Prisma dependencies in `server/`: `npm install @prisma/client` and `npm install -D prisma`.
   * Initialize `schema.prisma` with the blueprint provided in Section 5.
   * Run `npx prisma generate` to generate the type-safe client.
3. **Step 3 (Refactor Authentication & BOLA Security):**
   * Patch `authController.js` and `userController.js` to eliminate privilege escalation and mass assignment.
   * Fix `window.handleLogout` in `js/app.js` to ensure token removal.
4. **Step 4 (Frontend Script Synchronization):**
   * Add `../js/api.js` to `pages/admin.html`, `pages/edit-profile.html`, and `pages/profile.html`.
   * Wire `my-jobs.html` to consume API data directly.
