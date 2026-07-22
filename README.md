# 📦 Peleka Courier — Backend API (v2.0)

Complete backend for the **Peleka Courier** platform, powering:

- 🛵 The **Rider mobile app** (Flutter)
- 📱 The **Customer mobile app** (Flutter)
- 🖥️ The **Admin / Dispatch dashboard** (Web)

Built with **Next.js 14 (App Router API Routes)** + **PostgreSQL** (via native `pg` — no ORM) + **raw SQL migrations**.

---

## ✨ What's inside (v2.0)

### Core features (v1)
- **Auth** — email + password with bcrypt, JWT access + rotating refresh tokens, password reset, per-device session revocation
- **RBAC** — `customer`, `rider`, `admin`, `dispatcher`
- **Shipments** — quote → create → assign → pickup (with mandatory photo proof) → in-transit → deliver (with mandatory photo proof + optional signature) → rate
- **Distance-based pricing** — Google Maps Distance Matrix with Haversine fallback, admin-configurable rules, city-pair route overrides, discount codes
- **Live tracking** — GPS pings + location updates
- **Payments** — state machine ready for Stripe / M-Pesa / Flutterwave
- **Notifications** — in-app + FCM push
- **Audit log** — every action logged with actor, IP, UA, payload
- **File uploads** — multipart photo/PDF upload
- **Rate limiting** — per-IP guards on auth & write endpoints

### New in v2
- ✅ **Register/login with email OR phone** (email is now optional)
- ✅ **Google Sign-In** (`/api/auth/google`) — verify Google ID tokens server-side
- ✅ **Phone OTP** (`/api/auth/otp/{send,verify}`) — 6-digit codes via Twilio/Africa's Talking, or dev-log mode
- ✅ **Rider earnings with time series** (`/api/rider/earnings?groupBy=day|week|month`) + today / this-week / this-month cards
- ✅ **Admin live rider map** (`/api/admin/riders/live-locations`) — every online rider's current position + active shipment
- ✅ **Complaints support `lost` category** + **photo attachments**
- ✅ **Rider ↔ customer calling** (`/api/shipments/:id/contact`) — gated by active shipment + fully audited in `contact_access_logs`
- ✅ **Neon-friendly** — separate `DIRECT_URL` for migrations, pooled `DATABASE_URL` for runtime

---

## 🚀 Quick start

```bash
# 1. Install
npm install

# 2. Configure environment
cp .env.example .env.local
# Fill in DATABASE_URL / DIRECT_URL, JWT secrets, GOOGLE_MAPS_API_KEY,
# GOOGLE_CLIENT_IDS (optional), SMS provider (optional).

# 3. Run migrations (uses DIRECT_URL if set)
npm run migrate

# 4. Seed bootstrap admin + default pricing
npm run seed

# 5. Start
npm run dev            # http://localhost:3000
```

Verify:

```bash
curl http://localhost:3000/api/health
# → { "success": true, "data": { "status": "healthy", "db": true } }
```

### Neon-specific setup

Neon exposes **two** connection URLs:

- **Pooled URL** (has `-pooler` in the hostname) → set as `DATABASE_URL`
- **Direct URL** (no `-pooler`) → set as `DIRECT_URL`

```env
DATABASE_URL=postgresql://user:pass@ep-xxxx-pooler.eu-central-1.aws.neon.tech/peleka?sslmode=require
DIRECT_URL=postgresql://user:pass@ep-xxxx.eu-central-1.aws.neon.tech/peleka?sslmode=require
```

The pool (used by API routes) uses the pooled URL. `migrate.js` and `seed.js` use the direct URL, since PgBouncer transaction mode does not play well with long DDL / advisory locks.

---

## 🔐 Auth flow

### Classic (email or phone + password)

```bash
# Register (email OR phone required, both accepted)
POST /api/auth/register  { email?, phone?, password, full_name }

# Login
POST /api/auth/login     { email? | phone?, password }
```

### Google Sign-In

```bash
POST /api/auth/google    { id_token }   # ID token from client-side Google SDK
```

Server verifies the token against Google, creates/links the account, returns `{ user, access_token, refresh_token }`.

### Phone OTP

```bash
# 1. Request code
POST /api/auth/otp/send  { phone, purpose?: 'login'|'signup'|'verify' }
# → in dev, the response includes `_dev_code`; the terminal logs it too.

# 2. Verify + sign in (or auto-create account)
POST /api/auth/otp/verify { phone, code, full_name? }
```

If the phone doesn't have an account yet, `full_name` is required to create one.

### Tokens

- **Access token** (default 15 min) → `Authorization: Bearer <token>` on every request
- **Refresh token** (default 30 days) → sent to `/api/auth/refresh` for rotation

Both are safely stored: refresh JTIs are hashed (SHA-256) in `refresh_tokens`; password changes and resets revoke all sessions.

---

## 🗺️ Pricing formula

```
distance_fee   = max(0, distance_km − free_km) × price_per_km
weight_fee     = parcel_weight_kg × price_per_kg
time_fee       = duration_minutes × price_per_minute
raw            = (base_fare + distance_fee + weight_fee + time_fee) × surge_multiplier
subtotal       = clamp(raw, min_price, max_price)
after_discount = max(0, subtotal − discount_amount)
tax_amount     = after_discount × tax_percentage / 100
total_price    = after_discount + tax_amount
rider_earnings = after_discount × rider_commission_percentage / 100
```

A **route override** (`route_prices` matching origin/destination cities) short-circuits with a flat price but still applies discounts + taxes.

---

## 📚 API surface (base = `/api`)

Legend: 🟢 public · 🔵 authenticated · 🟠 customer · 🟡 rider · 🔴 admin/dispatcher

### Auth

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `/auth/register` | 🟢 (email OR phone) |
| POST | `/auth/login` | 🟢 (email OR phone) |
| POST | `/auth/google` **v2** | 🟢 |
| POST | `/auth/otp/send` **v2** | 🟢 |
| POST | `/auth/otp/verify` **v2** | 🟢 |
| POST | `/auth/refresh` | 🟢 |
| POST | `/auth/logout` | 🔵 |
| POST | `/auth/forgot-password` | 🟢 |
| POST | `/auth/reset-password` | 🟢 |

### Profile

| Method | Path | Access |
| ------ | ---- | ------ |
| GET/PATCH | `/me` | 🔵 |
| POST | `/me/password` | 🔵 |
| POST/DELETE | `/me/device-tokens` | 🔵 |
| GET/PATCH | `/me/notifications` | 🔵 |
| PATCH | `/me/notifications/:id/read` | 🔵 |

### Shipments

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `/shipments/quote` | 🟢 (rate-limited) |
| POST/GET | `/shipments` | 🟠 own · 🟡 assigned |
| GET | `/shipments/:id` | 🟠 own · 🟡 assigned · 🔴 |
| POST | `/shipments/:id/cancel` | 🟠 own · 🔴 |
| PATCH | `/shipments/:id/status` | 🟡 assigned · 🔴 |
| POST/GET | `/shipments/:id/proofs` | 🟡 (POST) · 🔵 authorized (GET) |
| POST | `/shipments/:id/rating` | 🟠 owner (post-delivery) |
| POST/GET | `/shipments/:id/track` | 🟡 (POST) · 🔵 (GET) |
| GET | `/shipments/:id/contact` **v2** | Gated by role + active shipment |

### Rider

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | `/rider/assignments?status=offered` | 🟡 |
| POST | `/rider/assignments/:id/accept` | 🟡 |
| POST | `/rider/assignments/:id/reject` | 🟡 |
| GET | `/rider/jobs` | 🟡 |
| POST | `/rider/location` | 🟡 |
| PATCH | `/rider/status` | 🟡 |
| GET | `/rider/earnings?groupBy=day\|week\|month` **v2** | 🟡 |

### Admin / Dispatcher

| Method | Path | Access |
| ------ | ---- | ------ |
| GET | `/admin/dashboard` | 🔴 |
| GET | `/admin/users?role=&q=` | 🔴 admin |
| GET | `/admin/customers?q=` | 🔴 |
| GET | `/admin/riders?status=&q=` | 🔴 |
| POST | `/admin/riders` | 🔴 admin |
| POST | `/admin/riders/:id/approve` | 🔴 admin |
| POST | `/admin/riders/:id/suspend` | 🔴 admin |
| GET | `/admin/riders/live-locations?withinMinutes=10` **v2** | 🔴 |
| GET | `/admin/shipments?status=&rider_id=&customer_id=&from=&to=&q=` | 🔴 |
| POST | `/admin/shipments/:id/assign` | 🔴 |
| POST | `/admin/shipments/:id/reassign` | 🔴 |
| POST/GET | `/admin/pricing/configs` | 🔴 |
| GET/PATCH | `/admin/pricing/configs/:id` | 🔴 |
| POST/GET | `/admin/pricing/discounts` | 🔴 |
| PATCH/DELETE | `/admin/pricing/discounts/:id` | 🔴 |
| POST/GET | `/admin/pricing/routes` | 🔴 |
| PATCH/DELETE | `/admin/pricing/routes/:id` | 🔴 |
| GET | `/admin/complaints?status=` | 🔴 |
| PATCH | `/admin/complaints/:id` | 🔴 |
| GET | `/admin/reports/revenue?from=&to=&groupBy=day\|week\|month` | 🔴 |
| GET | `/admin/reports/deliveries?from=&to=` | 🔴 |
| GET | `/admin/reports/riders?from=&to=` | 🔴 |

### Payments, Complaints, Uploads, Tracking

| Method | Path | Access |
| ------ | ---- | ------ |
| POST | `/payments` | 🟠 own · 🔴 |
| PATCH | `/payments/:id` | 🔴 admin / webhook |
| POST/GET | `/complaints` (with attachments) **v2** | 🔵 |
| POST | `/uploads` | 🔵 |
| GET | `/track/:trackingNumber` | 🟢 |
| GET | `/health` | 🟢 |

All list endpoints support `?page=1&pageSize=20&sort=col.asc|desc`.

Responses use a uniform shape:

```json
{ "success": true,  "data": { ... }, "meta": { "page": 1, "pageSize": 20, "total": 137, "totalPages": 7 } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "details": { ... } } }
```

---

## 🔁 Shipment state machine

```
awaiting_assignment
        │  (admin assigns → rider accepts)
        ▼
     assigned
        │  (rider starts moving)
        ▼
rider_en_route_to_pickup
        │  (rider uploads pickup_photo, PATCH status=picked_up)
        ▼
    picked_up ──► in_transit ──► out_for_delivery
                                      │  (delivery_photo [+ signature if requires_signature])
                                      ▼
                                  delivered
```

Pre-pickup states can also transition to `cancelled` (owner/admin) or `failed_pickup`. `in_transit`/`out_for_delivery` can go to `failed_delivery` or `returned`. **Illegal transitions are rejected server-side.**

---

## 🎯 New v2 endpoints in detail

### `GET /api/rider/earnings?groupBy=day|week|month`

```json
{
  "range": { "from": null, "to": null, "groupBy": "day" },
  "totals": { "completed_jobs": 42, "total_earnings": "168.50", "currency": "USD" },
  "series": [
    { "bucket": "2026-07-21T00:00:00.000Z", "deliveries": 3, "earnings": "12.50" }
  ],
  "today":      { "deliveries": 3, "earnings": "12.50" },
  "this_week":  { "deliveries": 12, "earnings": "48.00" },
  "this_month": { "deliveries": 42, "earnings": "168.50" },
  "recent_deliveries": [...],
  "profile": { "rating_avg": "4.85", "rating_count": 78, "completed_jobs": 128, "status": "online" }
}
```

### `GET /api/admin/riders/live-locations?withinMinutes=10`

Returns all riders with a recent ping — ready to drop markers on a Google Map. Includes each rider's `active_shipment` so the tooltip can show what they're delivering. Poll every 5–10 seconds.

### `POST /api/auth/google`

```json
POST /api/auth/google
{ "id_token": "<google id_token from Flutter google_sign_in>" }
```

Server verifies against Google's `tokeninfo`, checks the audience matches `GOOGLE_CLIENT_IDS`, links or creates the user, returns `{ user, access_token, refresh_token }`.

### `POST /api/auth/otp/{send,verify}`

Six-digit codes, 5-minute TTL, max 5 attempts, 60-second resend cooldown. Codes are stored as SHA-256 hashes. In dev mode, `_dev_code` is returned so you can test without an SMS provider.

### `GET /api/shipments/:id/contact`

Returns phone numbers **only while the shipment is active**:

- Rider (assigned) → customer/sender/recipient phones
- Customer (owner) → rider phone
- Admin → everything

Every disclosure is written to `contact_access_logs` — critical for privacy/GDPR compliance.

**Flutter usage:**

```dart
final res = await api.get('/shipments/$id/contact');
final phone = res.data['customer']['phone']; // rider calling customer
await launchUrl(Uri.parse('tel:$phone'));
```

### Complaints with attachments

```json
POST /api/complaints
{
  "shipment_id": "…",
  "category": "lost",
  "subject": "Parcel never arrived",
  "description": "Marked delivered but not received.",
  "attachments": [
    { "url": "https://.../damaged.jpg", "mime_type": "image/jpeg", "size": 45231 }
  ]
}
```

Categories: `failed_pickup | failed_delivery | damage | delay | lost | other`.

---

## 📁 Project layout

```
peleka-backend/
├── migrations/                  # 5 SQL migrations (v2 changes integrated)
│   ├── 001_extensions_and_enums.sql
│   ├── 002_users_and_auth.sql            (+ google_sub, phone_otps, live-riders idx)
│   ├── 003_pricing.sql
│   ├── 004_shipments.sql
│   └── 005_payments_ratings_notifications_audit.sql  (+ lost category, attachments, contact_access_logs)
├── scripts/
│   ├── migrate.js               # DIRECT_URL-aware runner
│   └── seed.js                  # bootstrap admin + default pricing
├── src/
│   ├── lib/                     # 17 helper modules
│   │   ├── db.js, auth.js, jwt.js, password.js
│   │   ├── validation.js (v2 schemas), middleware.js
│   │   ├── errors.js, response.js, route-helpers.js
│   │   ├── pricing.js, distance.js
│   │   ├── audit.js, notifications.js, upload.js
│   │   ├── google.js (v2)       # Google ID-token verifier
│   │   ├── otp.js    (v2)       # OTP issue/verify
│   │   └── sms.js    (v2)       # Twilio / Africa's Talking / dev-log
│   └── app/api/... (58 route.js files)
├── .env.example
├── package.json
├── next.config.js
├── jsconfig.json
└── README.md
```

---

## 🛡️ Production checklist

- [ ] Strong unique `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` (≥ 64 chars)
- [ ] Enable SSL (Neon: `?sslmode=require` in both URLs, or `PGSSL=true`)
- [ ] Set `GOOGLE_CLIENT_IDS` if using Google Sign-In
- [ ] Set `SMS_PROVIDER=twilio` (or `at`) + provider credentials for OTP in production
- [ ] Swap the in-memory rate limiter for Redis if scaling horizontally
- [ ] Move uploads to S3/GCS/Azure Blob (replace `saveBufferToStorage` in `src/lib/upload.js`)
- [ ] Restrict `CORS_ORIGIN` to your web dashboard origin(s)
- [ ] Add TLS in front (nginx, Caddy, or platform load balancer)
- [ ] Wire real payment providers + webhook signature verification
- [ ] Daily backups + monitoring on `audit_logs` and `contact_access_logs` growth
- [ ] Rotate the bootstrap admin password on first login

---

## 📱 Flutter integration notes

- Store the **access token** in memory; persist the **refresh token** in `flutter_secure_storage`
- Add a Dio interceptor that auto-calls `/auth/refresh` on 401 and retries the original request once
- Register the device's FCM/APNs token via `POST /me/device-tokens` right after login
- The rider app should POST `/rider/location` on a timer (every 10 s while online) and `/shipments/:id/track` during a job
- Customer live tracking: poll `/shipments/:id/track` every 5–10 s (add WebSockets later at scale)
- Native calling: hit `/shipments/:id/contact` then `launchUrl(Uri.parse('tel:$phone'))`
- Google Sign-In: use `google_sign_in` package, forward the `id_token` to `/auth/google`
- Phone OTP: use `sms_autofill` or manual input, hit `/auth/otp/send` then `/auth/otp/verify`

---

## 🧾 License

Copyright © Peleka. All rights reserved.
