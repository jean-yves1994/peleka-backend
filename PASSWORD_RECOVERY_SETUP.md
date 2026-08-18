# Peleka Password Recovery Setup

## Flow
- Email identifier -> secure one-time password reset token -> email link -> reset password.
- Phone identifier -> Peleka-generated 6-digit OTP -> SMS -> verify -> one-time password reset token -> reset password.
- Normal login remains email/phone + password.
- Registration remains immediate `active`; no Firebase is required.

## Backend environment variables

### Email recovery (Resend)
```env
RESEND_API_KEY=re_xxxxxxxxx
EMAIL_FROM=Peleka <no-reply@your-verified-domain.com>
PASSWORD_RESET_URL=peleka://reset-password?token={{token}}
```

`PASSWORD_RESET_URL` is deliberately configurable. For production mobile deep linking, replace the custom scheme with the HTTPS App Link/Universal Link you configure for the Customer app, keeping `{{token}}` in the URL.

Resend is called server-side from the backend; the API key must never be placed in Flutter.

### Phone recovery (choose one)
Twilio:
```env
SMS_PROVIDER=twilio
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM=...
```

Africa's Talking:
```env
SMS_PROVIDER=at
AT_USERNAME=...
AT_API_KEY=...
AT_FROM=...
```

### OTP defaults
```env
OTP_TTL_MINUTES=5
OTP_MAX_ATTEMPTS=5
OTP_RESEND_COOLDOWN_SEC=60
```

## Endpoints

`POST /api/auth/forgot-password`
```json
{"identifier":"customer@example.com"}
```
or
```json
{"identifier":"+250788123456"}
```

`POST /api/auth/password-reset/phone/verify`
```json
{"phone":"+250788123456","code":"123456"}
```

`POST /api/auth/reset-password`
```json
{"token":"...","password":"NewPassword123"}
```

## Security
- Reset tokens are random and only their hashes are stored in PostgreSQL.
- Reset tokens expire after 60 minutes and are single-use.
- Existing refresh sessions are revoked after a successful reset.
- Phone OTPs are hashed, expire after 5 minutes, and have a maximum attempt count.
- Forgot-password responses do not reveal whether an account exists.
- SMS/email provider credentials stay on the backend.

## Customer app deep link
The Customer app now has `/reset-password?token=...` and also accepts a router `extra` token for the in-app phone recovery flow. To open the email link directly into the app, configure Android App Links/iOS Universal Links (or a custom URL scheme) using your existing Flutter project configuration. The uploaded package did not include `pubspec.yaml` or native Android/iOS configuration, so those platform files were intentionally not changed here.
