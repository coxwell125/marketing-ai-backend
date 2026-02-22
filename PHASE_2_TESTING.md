# Phase 2: Testing Guide

Complete curl commands to test the **real Meta Marketing API integration**.

---

## ✅ Prerequisites

Before running these tests:

1. ✅ Complete [PHASE_2_META_API_SETUP.md](./PHASE_2_META_API_SETUP.md)
2. ✅ Update your `.env` file with real credentials:
   ```env
   ENABLE_META_API=true
   META_SYSTEM_USER_TOKEN=your_token_here
   META_AD_ACCOUNT_ID=act_your_id_here
   ```
3. ✅ Restart server: `npm run dev`

---

## 🧪 Test Commands

### Test 1: Health Check (No Auth Required)
```bash
curl -s http://localhost:8080/health | jq .
```

**Expected Response:**
```json
{
  "ok": true,
  "service": "marketing-ai-backend"
}
```

---

### Test 2: Get Meta Spend (Real API - with PowerShell)

```powershell
$body = @{ message = "How much meta spend today?" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:8080/api/chat" `
  -Method POST `
  -Headers @{"x-api-key"="super-secret-123"} `
  -ContentType "application/json" `
  -Body $body | ConvertTo-Json -Depth 5
```

**Expected Response (with real data from Meta API):**
```json
{
  "ok": true,
  "mode": "mcp",
  "tool": {
    "name": "get_meta_spend_today",
    "args": {
      "time_zone": "Asia/Kolkata",
      "currency": "INR"
    }
  },
  "answer": "📊 Real Data\n\n**Date:** 2026-02-18 (Asia/Kolkata)\n**Spend:** INR 1250.50\n**Impressions:** 45,320\n**Clicks:** 1,240\n**Conversions:** 23\n**Cost/Click:** INR 1.01\n**CTR:** 2.74%",
  "data": {
    "account_id": "act_123456789",
    "date": "2026-02-18",
    "currency": "INR",
    "spend": 1250.50,
    "impressions": 45320,
    "clicks": 1240,
    "conversions": 23,
    "cpc": 1.01,
    "ctr": 2.74,
    "source": "meta_api"
  },
  "source": "meta_api",
  "debug": {
    "isRealData": true,
    "timestamp": "2026-02-18T10:30:00.000Z"
  }
}
```

---

### Test 3: Check API Rate Limiting

Make 201 requests rapidly (should get 429 after 200):

```bash
# Bash version
for i in {1..210}; do
  echo "Request $i..."
  curl -s http://localhost:8080/api/chat \
    -X POST \
    -H "Content-Type: application/json" \
    -H "x-api-key: super-secret-123" \
    -d '{"message":"How much meta spend today?"}' | jq '.ok, .data.error'
  sleep 0.1
done | tail -20
```

**Expected: Last 10 requests should show error:**
```json
{
  "ok": false,
  "code": "RATE_LIMITED",
  "userMessage": "Too many requests. Please try again later."
}
```

---

### Test 4: Test With Different Dates (PowerShell)

```powershell
# Test with yesterday's date
$body = @{ 
  message = "Get meta spend for 2026-02-17" 
} | ConvertTo-Json

Invoke-RestMethod -Uri "http://localhost:8080/api/chat" `
  -Method POST `
  -Headers @{"x-api-key"="super-secret-123"} `
  -ContentType "application/json" `
  -Body $body
```

---

### Test 5: Test Error Handling - No Token

Set `.env` with invalid token:
```env
ENABLE_META_API=true
META_SYSTEM_USER_TOKEN=invalid_fake_token_12345
META_AD_ACCOUNT_ID=act_123456789
```

Restart and run:
```powershell
$body = @{ message = "How much meta spend today?" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://localhost:8080/api/chat" `
  -Method POST `
  -Headers @{"x-api-key"="super-secret-123"} `
  -ContentType "application/json" `
  -Body $body
```

**Expected: Graceful fallback to mock data:**
```json
{
  "ok": true,
  "answer": "📋 Mock Data\n\n**Date:** 2026-02-18 (UTC)\n...",
  "data": {
    "source": "mock",
    "spend": 612.00
  },
  "debug": {
    "isRealData": false
  }
}
```

---

### Test 6: Test API Key Protection

Without API key (should fail):
```bash
curl -s http://localhost:8080/api/chat \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"message":"How much meta spend today?"}'
```

**Expected: 401 Unauthorized**
```json
{
  "ok": false,
  "error": "Unauthorized"
}
```

---

### Test 7: Live Meta API Validation

Direct curl to Meta API (for debugging):

```bash
curl -s "https://graph.facebook.com/v19.0/act_YOUR_ACCOUNT_ID/insights?fields=spend,impressions&access_token=YOUR_TOKEN"
```

Replace:
- `act_YOUR_ACCOUNT_ID` → Your actual Meta account ID
- `YOUR_TOKEN` → Your System User token

**Expected response:**
```json
{
  "data": [
    {
      "spend": "1250.50",
      "impressions": 45320
    }
  ]
}
```

---

## 📊 Debugging Tips

### Check Server Logs

Watch the dev server output:
```
[META] Calling real Meta API for 2026-02-18 in UTC
[META] Rate limit: 199/200 calls remaining
[DEBUG] toolResult type: object keys: source,account_id,date,spend...
```

### Common Errors

| Error | Cause | Fix |
|-------|-------|-----|
| `AUTH_FAILED` | Invalid token | Regenerate System User token |
| `RATE_LIMITED` | Too many calls | Wait 1 hour or reduce limit |
| `INVALID_ACCOUNT_ID` | Wrong format | Use `act_XXXXXXXXX` format |
| `falls back to mock` | API credentials missing | Check `.env` has all fields |

### Enable Debug Mode

Add to `.env`:
```env
DEBUG=meta-api,*
```

Then restart and watch logs:
```bash
npm run dev 2>&1 | grep META
```

---

## 🔄 Switching Between Real and Mock

### Use Real API:
```env
ENABLE_META_API=true
META_SYSTEM_USER_TOKEN=your_real_token
```

### Use Mock (for testing):
```env
ENABLE_META_API=false
# Token doesn't matter when disabled
```

Restart and test — should automatically switch!

---

## ✅ Success Indicators

After setup, you should see:

✅ Real spend data from Meta API  
✅ Date matches your request  
✅ Impressions, clicks, conversions populated  
✅ Cost metrics calculated (CPC, CTR)  
✅ Rate limiting working (429 after 200 calls)  
✅ Graceful fallback to mock on errors  
✅ All responses authenticated with API key  

---

## 🚀 Next Steps

After Tests Pass:

1. Deploy to Render
2. Set production `.env` in Render dashboard
3. Test production endpoints
4. Monitor error logs
5. Celebrate! 🎉
