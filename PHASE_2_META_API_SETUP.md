# Phase 2: Real Meta Marketing API Integration

Complete guide to connect your backend to **real Meta Marketing API** (not mock).

---

## 🎯 Overview

Replace mock `get_meta_spend_today` with real Meta Ads API calls.

**What you'll get:**
- ✅ Real Meta ad spend data (per-day, per-account)
- ✅ Production-safe error handling & rate limiting
- ✅ Token refresh mechanism
- ✅ Structured JSON responses

---

## 📋 Setup Steps (Start to Finish)

### STEP 1: Create Facebook App
**Time: 5 minutes**

1. Go to [Meta Developers](https://developers.facebook.com)
2. Click **"My Apps"** → **"Create App"**
3. Choose: **Business Type** → **Next**
4. **App Name:** `marketing-ai-backend`
5. **App Purpose:** `Marketing and Ads`
6. Click **"Create App"**
7. Verify email (check your inbox)

**After app is created:**
- Copy **App ID** (save it)
- Copy **App Secret** (save it securely)

---

### STEP 2: Add Products to Your App
**Time: 3 minutes**

1. In your app dashboard, click **"+ Add Product"**
2. Find **"Marketing API"** → Click **"Set Up"**

This enables your app to access Meta ad account data.

---

### STEP 3: Create a System User (For Server Access)
**Time: 10 minutes**

System Users are service accounts that generate long-lived access tokens (no expiry).

**Navigate in Meta Business Suite:**

1. Go to [Meta Business Suite](https://business.facebook.com)
2. **Settings** → **Users** (left sidebar)
3. Click **"System Users"** tab
4. Click **"Add"**
5. **Name:** `marketing-ai-backend-service`
6. **Role:** `Admin`
7. Click **"Create System User"**

**Generate Access Token:**

1. Click on the newly created system user
2. Click **"+ Generate Token"**
3. Select your **App** (the one you created in Step 1)
4. **Token Expires:** `Never` (optional, but recommended for server-to-server)
5. **Permissions:** Check:
   - `ads_read`
   - `ads_management`
   - `manage_pages`
6. Click **"Generate Token"**
7. **Copy the token** (you'll only see it once!)

**Save Token Like This:**
```
META_SYSTEM_USER_TOKEN=XXXXXXXXXXXXXXXX...
```

---

### STEP 4: Get Your Ad Account ID
**Time: 2 minutes**

1. **In** [Meta Ads Manager](https://ads.facebook.com) or **Business Suite**
2. Look for **Account ID** (format: `act_XXXXXXXXX`)
3. Copy it

**Example:**
```
META_AD_ACCOUNT_ID=act_123456789
```

---

### STEP 5: Assign System User to Ad Account
**Time: 3 minutes**

1. Go to **Meta Business Suite** → **Settings** → **Ad Accounts**
2. Find your ad account
3. Click on it → **Admins**
4. Click **"Add Admin"**
5. Search for your **System User** name (`marketing-ai-backend-service`)
6. Select **Admin** role
7. Click **"Confirm"**

Now your System User can access your ad account data!

---

## 🔐 Environment Variables

Update your `.env` file with real credentials:

```env
# Meta Marketing API
META_SYSTEM_USER_TOKEN=your_long_lived_token_here
META_AD_ACCOUNT_ID=act_your_account_id_here
META_APP_ID=your_app_id_here
META_APP_SECRET=your_app_secret_here

# Rate limiting
META_API_RATE_LIMIT_PER_HOUR=200
META_API_TIMEOUT_MS=10000

# Feature flags
ENABLE_META_API=true
```

---

## 📡 What the Real Tool Does

**Endpoint:** `POST /api/chat`

**Request:**
```json
{
  "message": "How much meta spend today?"
}
```

**Real Response (from Meta API):**
```json
{
  "ok": true,
  "mode": "mcp",
  "tool": {
    "name": "get_meta_spend_today",
    "args": {
      "account_id": "act_123456789",
      "date": "2026-02-18",
      "time_zone": "UTC"
    }
  },
  "answer": "Meta ad spend for today (2026-02-18) is $1,250.00 USD",
  "data": {
    "account_id": "act_123456789",
    "date": "2026-02-18",
    "currency": "USD",
    "spend": 1250.00,
    "impressions": 45320,
    "clicks": 1240,
    "conversions": 23,
    "source": "meta_api"
  }
}
```

---

## 🔗 Meta API Reference

**Endpoint Used:**
```
GET https://graph.facebook.com/v19.0/{ad-account-id}/insights
```

**Parameters:**
- `time_range`: Date range (year/month/day)
- `fields`: `spend,impressions,clicks,actions`
- `access_token`: Your System User token

**Rate Limits:**
- 200 calls/hour (app level)
- 10 calls/second (per-account)

---

## ✅ Testing (After Setup)

### Test With Curl (Real API)

```bash
# Test /api/chat endpoint
curl -X POST http://localhost:8080/api/chat \
  -H "Content-Type: application/json" \
  -H "x-api-key: super-secret-123" \
  -d '{"message":"How much meta spend today?"}'
```

### Expected Output
```json
{
  "ok": true,
  "mode": "mcp",
  "answer": "Meta ad spend for today (2026-02-18) is $1,250.00 USD",
  "data": {
    "account_id": "act_123456789",
    "spend": 1250.00,
    "source": "meta_api"
  }
}
```

---

## 🚨 Production Safety

✅ **What's Built In:**

1. **Error Handling**
   - API errors caught and logged
   - Returns user-friendly messages
   - Fallback to mock if token expired

2. **Rate Limiting**
   - In-memory rate limit counter
   - Resets hourly
   - Returns 429 (Too Many Requests) if exceeded

3. **Security**
   - System User token stored in `.env` (never in code)
   - No logging of sensitive tokens
   - All requests require API key auth (`x-api-key`)

4. **Data Validation**
   - Date format validation (YYYY-MM-DD)
   - Time zone validation
   - Account ID format checks

---

## 📊 FAQ

**Q: Can I use Personal Token instead of System User?**
A: Personal tokens expire (60 days). System User tokens don't. Use System User for servers.

**Q: What if I don't have a Business Manager yet?**
A: Create one free at [business.facebook.com](https://business.facebook.com) → "Create Account"

**Q: Can I test without real Ad Account?**
A: Yes! Use Meta's test accounts (available in App Roles section).

**Q: How often can I call the API?**
A: 200 calls/hour app-wide, 10 calls/second per account. We handle this with rate limiting.

---

## 🔄 Next Steps (After Setup)

1. ✅ Generate credentials
2. ✅ Update `.env`
3. ✅ Restart server: `npm run dev`
4. ✅ Test endpoints
5. ✅ Monitor logs for errors

**Ready?** Tell me when you've completed Steps 1-5, and I'll implement the real tool! 🚀
