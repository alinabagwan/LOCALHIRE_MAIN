# LocalHire — PostgreSQL & Prisma Database Setup Guide

Welcome! This guide is for the team member configuring the PostgreSQL database for the **LocalHire** home-services marketplace.

Follow these step-by-step instructions to set up the development database, apply version-controlled migrations, seed fictional development data, and verify the backend connection.

---

## 1. Prerequisites

Before starting, ensure your machine has:
* **Node.js**: v18.0.0 or later (v20+ or v24 LTS recommended)
* **npm**: v9.0.0 or later
* **PostgreSQL**: Version 15 or 16 (includes `psql` command-line utility and optionally pgAdmin 4)

---

## 2. Install PostgreSQL on Your Laptop

### On Windows:
1. Download the official installer from [EnterpriseDB PostgreSQL](https://www.enterprisedb.com/downloads/postgres-postgresql-downloads).
2. Run the installer. Choose PostgreSQL 15 or 16.
3. During setup, keep the default port **5432** and set a password for the default `postgres` superuser (make a note of it).
4. Complete installation (Stack Builder is optional and can be skipped).

### On macOS (via Homebrew):
```bash
brew install postgresql@16
brew services start postgresql@16
```

### On Linux (Ubuntu / Debian):
```bash
sudo apt update
sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql
sudo systemctl enable postgresql
```

---

## 3. Create the Database and Dedicated User

Open your terminal (PowerShell, Command Prompt, or Bash) or pgAdmin 4 Query Tool, and run:

```bash
# Connect as the postgres superuser:
# Windows (PowerShell/CMD):
psql -U postgres

# Linux/macOS:
sudo -u postgres psql
```

Once inside the `psql` prompt (`postgres=#`), execute the following SQL commands:

```sql
-- 1. Create a dedicated development user (choose a strong password)
CREATE USER localhire_dev WITH PASSWORD 'SecureDevPassword2026!';

-- 2. Create the dedicated database owned by this user
CREATE DATABASE localhire_db OWNER localhire_dev;

-- 3. Grant full privileges to the localhire_dev user
GRANT ALL PRIVILEGES ON DATABASE localhire_db TO localhire_dev;

-- 4. Connect to the newly created database
\c localhire_db

-- 5. Grant schema permissions
GRANT ALL ON SCHEMA public TO localhire_dev;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO localhire_dev;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO localhire_dev;

-- 6. Exit psql
\q
```

---

## 4. Environment Configuration (`.env`)

1. Open your terminal in the `server/` directory:
   ```bash
   cd LOCALHIRE_WEBSITE-main/server
   ```
2. Copy the template `.env.example` to create your active `.env`:
   ```bash
   # On Windows (PowerShell):
   Copy-Item .env.example .env

   # On macOS / Linux:
   cp .env.example .env
   ```
3. Open `.env` in your editor and configure `DATABASE_URL`:

   ```env
   PORT=5000
   NODE_ENV=development
   CLIENT_URL=http://localhost:5500

   JWT_SECRET=super_secret_localhire_jwt_key_2026_dev_only

   # Connection string format:
   # postgresql://<USER>:<PASSWORD>@<HOST>:<PORT>/<DATABASE>?schema=public
   DATABASE_URL="postgresql://localhire_dev:SecureDevPassword2026!@localhost:5432/localhire_db?schema=public"
   ```

> **Security Note:** The `.env` file is excluded in `.gitignore` and must never be committed to Git.

---

## 5. Install Dependencies & Generate Prisma Client

Run the following commands inside `server/`:

```bash
# 1. Install all dependencies (Express, Prisma, bcryptjs, etc.)
npm install

# 2. Generate the Prisma Client from the schema
npx prisma generate
```

You should see:
```text
✔ Generated Prisma Client (v6.19.3) to .\node_modules\@prisma\client
```

---

## 6. Apply Database Migrations

The repository contains the committed initial migration file (`prisma/migrations/20261018000000_init/migration.sql`). Apply it using Prisma:

```bash
npm run prisma:migrate:deploy
```

Or directly via npx:
```bash
npx prisma migrate deploy
```

This will create:
* Enums: `UserRole`, `BookingStatus`, `PaymentStatus`, `PriceType`, `UrgencyLevel`, etc.
* Tables: `User`, `CustomerAddress`, `ServiceCategory`, `ServiceItem`, `WorkerProfile`, `ProfessionalSkill`, `JobPost`, `JobApplication`, `Booking`, `BookingStatusHistory`, `EscrowPayment`, `Review`, `ChatMessage`, `SupportTicket`, `AuditLog`.
* All foreign key constraints, composite unique indexes, and performance indexes.

---

## 7. Seed Fictional Development Data

Populate the database with the home services taxonomy (Electrician, Plumber, Cleaner, Carpenter, AC Tech, etc.) and fictional accounts:

```bash
npm run prisma:seed
```

This populates:
* **8 Core Categories** and sample catalog items with standardized pricing.
* **Fictional Test Accounts** (All using development password: `DevPass@2026!`):
  - Admin: `admin@localhire.dev`
  - Customer: `customer@localhire.dev`
  - Electrician: `electrician@localhire.dev`
  - Plumber: `plumber@localhire.dev`
* Sample workflow data (Job Request -> Booking -> Escrow Payment -> Verified Review).

---

## 8. Test Database Connectivity

Run the automated health check script:

```bash
npm run db:check
```

**Expected output:**
```text
================================================================
[DB Health Check] Verifying PostgreSQL Connection for LocalHire
================================================================
[DB Health Check] Target Connection URI: postgresql://localhire_dev:********@localhost:5432/localhire_db?schema=public
[DB Health Check] Attempting connection...

✅ Status: SUCCESS — Successfully connected to PostgreSQL!
[DB Health Check] Tables present in public schema: 17
================================================================
Database is healthy and ready for LocalHire operations.
================================================================
```

---

## 9. Start the Backend API

```bash
npm run dev
# or: npm start
```

You will see:
```text
[Server] LocalHire API server running on port 5000
```

Verify in your browser:  
`http://localhost:5000/api/health` → `{"status":"OK","message":"LocalHire API is running live"}`

---

## 10. Network Architecture: Running on One Laptop vs. Two

### Scenario A: Running Backend on Your Laptop (Same as PostgreSQL)
* Both Express backend and PostgreSQL run on your laptop.
* `DATABASE_URL` uses `@localhost:5432`.
* Your friend accesses the API over local Wi-Fi or uses their own browser pointing to your IP (e.g. `http://192.168.1.50:5000`).

### Scenario B: Backend on Friend's Laptop, PostgreSQL on Your Laptop
If your friend runs the Node.js backend on their laptop and wants to connect to the PostgreSQL instance running on your laptop:
1. **Find your Local IP:**
   - On Windows: Run `ipconfig` (e.g., `192.168.1.45`).
   - On macOS/Linux: Run `ifconfig` or `ip addr`.
2. **Allow Remote PostgreSQL Connections on Your Laptop:**
   - In `postgresql.conf` (located in PostgreSQL data directory):
     ```text
     listen_addresses = '*'
     ```
   - In `pg_hba.conf`:
     ```text
     # Allow friend's machine on local subnet (e.g. 192.168.1.0/24)
     host    localhire_db    localhire_dev    192.168.1.0/24    scram-sha-256
     ```
   - Restart the PostgreSQL service.
   - Ensure Windows Defender Firewall allows inbound TCP traffic on port 5432 for Private Networks.
3. **Friend's `.env` on their laptop:**
   ```env
   DATABASE_URL="postgresql://localhire_dev:SecureDevPassword2026!@192.168.1.45:5432/localhire_db?schema=public"
   ```

### ⚠️ Critical Security Rules:
* **DO NOT EXPOSE PORT 5432 DIRECTLY TO THE PUBLIC INTERNET.** Do not configure router port-forwarding for port 5432. Automated bots scan for open database ports continuously.
* If connecting across different locations (not on the same Wi-Fi), use a secure mesh VPN like [Tailscale](https://tailscale.com/) or an SSH tunnel (`ssh -L 5432:localhost:5432 ...`).
* **Cloud Database Alternative:** If local network routing is difficult, consider a free shared development database on [Neon](https://neon.tech/) or [Supabase](https://supabase.com/). You both get a secure connection string with SSL mode enabled.

---

## 11. Useful Commands Cheat Sheet

| Command | Action |
| :--- | :--- |
| `npm run db:check` | Run connection diagnostic test |
| `npm run prisma:validate` | Validate schema syntax offline |
| `npm run prisma:generate` | Regenerate Prisma Client types |
| `npm run prisma:migrate:deploy` | Apply pending migrations |
| `npm run prisma:seed` | Seed fictional development data |
| `npm run db:import` | Import & reconcile MongoDB data (dry-run) |
| `npx prisma studio` | Open Prisma's interactive GUI database browser on port 5555 |
