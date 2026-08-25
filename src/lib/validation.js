/**
 * Zod schemas for request-body validation.
 */
const { z } = require("zod");

const email = z.string().trim().toLowerCase().email().max(160);
const phone = z
  .string()
  .trim()
  .min(6)
  .max(32)
  .regex(/^\+?[0-9\s\-()]+$/, "Invalid phone");
const password = z
  .string()
  .min(8)
  .max(128)
  .refine(
    (v) => /[A-Za-z]/.test(v) && /[0-9]/.test(v),
    "Password must contain at least one letter and one number",
  );
const lat = z.number().min(-90).max(90);
const lng = z.number().min(-180).max(180);
const uuid = z.string().uuid();

// --- Auth ---
// Accepts EITHER email OR phone (at least one required).
const registerCustomerSchema = z
  .object({
    email: email.optional(),
    confirm_email: email.optional(),
    phone: phone.optional(),
    confirm_phone: phone.optional(),
    password,
    confirm_password: z.string().min(1),
    full_name: z.string().trim().min(2).max(160),
  })
  .superRefine((v, ctx) => {
    if (!v.email && !v.phone) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Either email or phone is required",
        path: ["email"],
      });
    }
    if (v.email && v.confirm_email !== v.email) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Email addresses do not match",
        path: ["confirm_email"],
      });
    }
    if (v.phone) {
      const normalize = (value) =>
        String(value)
          .replace(/[\s\-()]/g, "")
          .trim();
      if (
        !v.confirm_phone ||
        normalize(v.confirm_phone) !== normalize(v.phone)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Phone numbers do not match",
          path: ["confirm_phone"],
        });
      }
    }
    if (v.password !== v.confirm_password) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Passwords do not match",
        path: ["confirm_password"],
      });
    }
  });

const customerAccountSchema = z.object({
  customer_type: z.enum(["standard", "premier"]),
  credit_limit: z.number().min(0).optional(),
});

const loginSchema = z
  .object({
    email: email.optional(),
    phone: phone.optional(),
    password: z.string().min(1),
  })
  .refine((v) => !!(v.email || v.phone), {
    message: "Either email or phone is required",
    path: ["email"],
  });

const refreshSchema = z.object({ refresh_token: z.string().min(20) });
const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3),
});
const resetPasswordSchema = z.object({ token: z.string().min(20), password });
const verifyPasswordResetPhoneSchema = z.object({
  phone: phone,
  code: z.string().regex(/^\d{6}$/, "Code must be 6 digits"),
});
const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: password,
});

// Google Sign-In remains available. Phone OTP registration/login is removed:
// phone accounts authenticate with the normal password flow.
const googleAuthSchema = z.object({ id_token: z.string().min(20) });

const updateProfileSchema = z.object({
  full_name: z.string().trim().min(2).max(160).optional(),
  phone: phone.optional(),
  avatar_url: z.string().url().optional(),
  default_address: z.string().max(500).optional(),
  default_lat: lat.optional(),
  default_lng: lng.optional(),
});

// --- Rider ---
const createRiderSchema = z.object({
  email,
  password,
  full_name: z.string().trim().min(2).max(160),
  phone,
  vehicle_type: z.string().min(2).max(40).default("motorcycle"),
  vehicle_plate: z.string().max(32).optional(),
  license_number: z.string().max(64).optional(),
  national_id: z.string().max(64).optional(),
});
const updateRiderStatusSchema = z.object({
  status: z.enum([
    "pending_approval",
    "approved",
    "suspended",
    "offline",
    "online",
    "busy",
  ]),
});
const riderLocationSchema = z.object({
  lat,
  lng,
  heading: z.number().min(0).max(360).optional(),
  speed_kph: z.number().min(0).max(500).optional(),
});

// --- Shipment ---
const quoteShipmentSchema = z.object({
  pickup_lat: lat,
  pickup_lng: lng,
  delivery_lat: lat,
  delivery_lng: lng,
  pickup_city: z.string().max(120).optional(),
  delivery_city: z.string().max(120).optional(),
  discount_code: z.string().max(60).optional(),
});
const createShipmentSchema = z.object({
  sender_name: z.string().trim().min(2).max(160),
  sender_phone: phone,
  recipient_name: z.string().trim().min(2).max(160),
  recipient_phone: phone,
  pickup_address: z.string().trim().min(3).max(500),
  pickup_city: z.string().max(120).optional(),
  pickup_lat: lat,
  pickup_lng: lng,
  pickup_notes: z.string().max(1000).optional(),
  pickup_scheduled_at: z.string().datetime().optional(),
  delivery_address: z.string().trim().min(3).max(500),
  delivery_city: z.string().max(120).optional(),
  delivery_lat: lat,
  delivery_lng: lng,
  delivery_notes: z.string().max(1000).optional(),
  delivery_scheduled_at: z.string().datetime().optional(),
  parcel_description: z.string().trim().min(2).max(500),
  parcel_category: z.string().max(60).optional(),
  // Weight is retained as shipment information for riders, but is not a
  // pricing input. The client may omit it.
  parcel_weight_kg: z.number().min(0.01).max(2000).optional().default(1),
  parcel_length_cm: z.number().min(0).max(1000).optional(),
  parcel_width_cm: z.number().min(0).max(1000).optional(),
  parcel_height_cm: z.number().min(0).max(1000).optional(),
  parcel_declared_value: z.number().min(0).max(1_000_000).optional(),
  is_fragile: z.boolean().optional().default(false),
  discount_code: z.string().max(60).optional(),
});
const assignShipmentSchema = z.object({
  rider_id: uuid,
  expires_in_minutes: z.number().int().min(1).max(1440).optional(),
});
const shipmentStatusUpdateSchema = z.object({
  status: z.enum([
    "rider_en_route_to_pickup",
    "picked_up",
    "in_transit",
    "out_for_delivery",
    "delivered",
    "failed_pickup",
    "failed_delivery",
    "returned",
    "cancelled",
  ]),
  note: z.string().max(500).optional(),
  lat: lat.optional(),
  lng: lng.optional(),
});
const cancelShipmentSchema = z.object({
  reason: z.string().trim().min(2).max(500),
});
const assignmentResponseSchema = z.object({
  reject_reason: z.string().max(300).optional(),
});
const uploadProofSchema = z.object({
  kind: z.enum(["pickup_photo", "delivery_photo"]),
  file_url: z.string().url(),
  mime_type: z.string().max(80).optional(),
  file_size: z.number().int().min(0).optional(),
  lat: lat.optional(),
  lng: lng.optional(),
});
const rateShipmentSchema = z.object({
  score: z.number().int().min(1).max(5),
  comment: z.string().max(1000).optional(),
});

// --- Pricing ---
const pricingConfigSchema = z.object({
  name: z.string().min(2).max(120),
  currency: z.string().min(3).max(8).default("USD"),
  base_fare: z.number().min(0),
  price_per_km: z.number().min(0),
  price_per_minute: z.number().min(0).default(0),
  min_price: z.number().min(0).default(0),
  max_price: z.number().min(0).optional(),
  surge_multiplier: z.number().min(0.1).max(10).default(1),
  tax_percentage: z.number().min(0).max(100).default(0),
  rider_commission_percentage: z.number().min(0).max(100).default(30),
  moto_commission_percentage: z.number().min(0).max(100).default(40),
  is_active: z.boolean().optional(),
});
const discountSchema = z.object({
  code: z.string().min(2).max(60),
  description: z.string().max(500).optional(),
  discount_type: z.enum(["percent", "fixed"]),
  amount: z.number().min(0),
  max_uses: z.number().int().min(1).optional(),
  valid_from: z.string().datetime().optional(),
  valid_to: z.string().datetime().optional(),
  is_active: z.boolean().optional(),
});

// --- Payment ---
const createPaymentSchema = z.object({
  shipment_id: uuid,
  method: z.enum(["cash", "card", "mobile_money", "wallet", "bank_transfer"]),
  provider: z.string().max(60).optional(),
  provider_ref: z.string().max(160).optional(),
});
const updatePaymentStatusSchema = z.object({
  status: z.enum([
    "pending",
    "authorized",
    "paid",
    "failed",
    "refunded",
    "cancelled",
  ]),
  provider_ref: z.string().max(160).optional(),
  failure_reason: z.string().max(500).optional(),
});

// --- Device tokens ---
const deviceTokenSchema = z.object({
  platform: z.enum(["ios", "android", "web"]),
  token: z.string().min(10).max(500),
});

// --- Complaints (v2 — 'lost' + attachments) ---
const complaintSchema = z.object({
  shipment_id: uuid.optional(),
  category: z.enum([
    "failed_pickup",
    "failed_delivery",
    "damage",
    "delay",
    "lost",
    "other",
  ]),
  subject: z.string().trim().min(2).max(200),
  description: z.string().trim().min(2).max(3000),
  attachments: z
    .array(
      z.object({
        url: z.string().url(),
        mime_type: z.string().max(80).optional(),
        size: z.number().int().min(0).optional(),
      }),
    )
    .max(10)
    .optional()
    .default([]),
});

module.exports = {
  registerCustomerSchema,
  loginSchema,
  refreshSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyPasswordResetPhoneSchema,
  changePasswordSchema,
  googleAuthSchema,
  updateProfileSchema,
  createRiderSchema,
  updateRiderStatusSchema,
  riderLocationSchema,
  quoteShipmentSchema,
  createShipmentSchema,
  assignShipmentSchema,
  shipmentStatusUpdateSchema,
  cancelShipmentSchema,
  assignmentResponseSchema,
  uploadProofSchema,
  rateShipmentSchema,
  pricingConfigSchema,
  discountSchema,
  createPaymentSchema,
  updatePaymentStatusSchema,
  deviceTokenSchema,
  complaintSchema,
  customerAccountSchema,
};
