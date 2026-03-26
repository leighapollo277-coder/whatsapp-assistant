# Automated Testing & CLI-First Debugging Plan

This plan enables the verification of complex AI logic (Links & Fact-checks) using only CLI tools and simulations.

## 1. Concept: Webhook Simulation
Instead of a physical WhatsApp device, we use `curl` to mimic the Twilio webhook POST requests that the server expects.

- **Endpoint**: `https://whatsapp-assistant-ex7w.onrender.com/api/webhook`
- **Verification**: Use `render logs` in a separate terminal to watch the results in real-time.

---

## 2. Test 1: Blogspot Link Extraction
**Objective**: Respond with 🎙️ within 10s and provide full summary + voice.

### Execution (CLI):
```bash
curl -X POST https://whatsapp-assistant-ex7w.onrender.com/api/whatsapp \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "Body=https://ymch130.blogspot.com/2026/02/w40-4.html?m=1" \
  -d "From=whatsapp:+85291234567" \
  -d "To=whatsapp:+14155238886"
```

### Success Criteria (Audit Logs):
```bash
render logs -r srv-d72g624hg0os738jtqu0 --limit 50 --output json | grep -iE "Extracted|voice chunks|Task completed"
```
- [ ] Log shows `🎙️` sent within 10s.
- [ ] Log shows `[processLink] Extracted X blocks`.
- [ ] Log shows `Link Reading: Generated X voice chunks`.

---

## 3. Test 2: Musk Screenshot Fact-Check
**Objective**: Correct fact-check content + voice message.

### Execution (CLI):
1. **Upload Image** (Mimic Twilio's MediaServer):
   `curl -F "reqtype=fileupload" -F "fileToUpload=@screenshot_musk.png" https://catbox.moe/user/api.php`
2. **Simulate Incoming Image**:
```bash
curl -X POST https://whatsapp-assistant-ex7w.onrender.com/api/whatsapp \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "MediaUrl0=[CATBOX_URL]" \
  -d "MediaContentType0=image/png" \
  -d "From=whatsapp:+85291234567" \
  -d "To=whatsapp:+14155238886"
```

### Success Criteria (Audit Logs):
- [ ] Log shows Intent Detection: `NEW_NOTE` or `FACT_CHECK`.
- [ ] Log shows Gemini analysis of the Musk/X-Money text.
- [ ] Log shows `generateAndSendVoice` triggered for the result.

---

## 4. Iterative Debugging Tool (`simulate_test.js`)
A Node.js script will automate this entire sequence, including the 10s timing check and log auditing.
