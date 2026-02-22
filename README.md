# sniphomesBack — AI Receptionist

A configurable AI phone receptionist powered by Google Gemini, Google TTS/STT, Twilio, and Calendly. A single codebase can power any type of business (autobody shop, dental clinic, etc.) by passing a typed `AgentConfig` object at call creation time.

---

## Prerequisites

- Node.js 18+
- A `.env` file in the project root (see below)
- A Twilio account with a phone number and a publicly reachable webhook URL
- A Google Cloud project with Speech-to-Text and Text-to-Speech APIs enabled
- A Calendly API key (only needed if using Calendly booking)

---

## Environment Variables

Create a `.env` file in the project root:

```
# Twilio
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Google (path to service account JSON, or set GOOGLE_APPLICATION_CREDENTIALS)
GOOGLE_APPLICATION_CREDENTIALS=./sniphomes-c18b4b87ca72.json
GOOGLE_SPEECH_TO_TEXT_KEY=./sniphomes-c18b4b87ca72.json

# Calendly
CALENDLY_API_KEY=eyJxxxxxxxxxxxxxxxxx

# Gemini
GEMINI_KEY=AIzaSyxxxxxxxxxxxxxxxxx

# App
PORT=3000
NODE_ENV=PROD

# Auth / sessions (web routes)
SECRET=your_cryptr_secret
COOKIESECRET=your_session_secret
EMAIL=you@gmail.com
PASSWORD=your_gmail_app_password
ADMINEMAIL=admin@example.com
RECEIVE_CREDENTIAL=your_internal_api_key
EMAIL_KEY_CRYPTR=your_email_cryptr_key

# MongoDB (only needed for web routes)
# mongoose.connect() call is in app.ts — uncomment and set:
# MONGO_URI=mongodb://localhost:27017/houseDB

# Stripe (only needed for billing routes)
STRIPE_SECRET_KEY=sk_live_xxxxxxx
STRIPE_WEBHOOK_SECRET_KEY=whsec_xxxxxxx
```

---

## Installation

```bash
npm install
```

---

## Running the Server

```bash
npm run dev
```

This runs `ts-node app.ts`. The server listens on the port set in `PORT`.

Twilio must be able to reach your server. In local development, use [ngrok](https://ngrok.com/) or a similar tunnel:

```bash
ngrok http 3000
```

Then set your Twilio phone number's webhook to:
```
https://<your-ngrok-subdomain>.ngrok.io/xml
```

---

## Running the Automated Test Suite

The test suite simulates full call conversations without real Twilio/TTS connections:

```bash
npm test
```

Results are written to `test_report.txt` in the project root.

---

## Adding a New Business (AgentConfig)

All business-specific configuration lives in `src/types/index.ts`. Two example configs are already exported:

- `QUATTRO_AUTOBODY_CONFIG` — autobody shop with Calendly booking
- `DENTAL_CLINIC_CONFIG` — dental clinic with no external booking

To add a new business:

1. Define a new `AgentConfig` constant in `src/types/index.ts` (or in its own file):

```typescript
import type { AgentConfig } from './src/types';

export const MY_BUSINESS_CONFIG: AgentConfig = {
  agentName:           'Alex',
  businessName:        'My Business',
  businessDescription: 'Book service appointments',
  businessLocation:    '123 Main St, City, ST 00000',
  businessHours:       '9am-5pm, M-F',
  services:            ['Service A', 'Service B'],
  transferNumber:      '555-000-0000',
  fields: [
    {
      key: 'customerName', label: 'your name',
      description: "Customer's full name.", type: 'text', required: true,
    },
    {
      key: 'customerEmail', label: 'your email',
      description: "Customer's email.", type: 'text', required: true,
      validations: [{ type: 'email', message: 'Must be a valid email address' }],
    },
    {
      key: 'appointmentTime', label: 'appointment time',
      description: "Copy the bracketed UTC ISO string verbatim from the slots list.",
      type: 'appointment_time', required: true,
    },
  ],
  booking: { provider: 'none' },  // or 'calendly' with full mapping
};
```

2. Pass the config when creating a call in `app.ts`:

```typescript
// Inbound (WebSocket handler, ~line 280 in app.ts):
const newCallInstance = await Call.create(callSid, phoneNum, MY_BUSINESS_CONFIG);

// Outbound:
callSomeone(phoneNumber, 'uuid-string');
// and update callSomeone() to use MY_BUSINESS_CONFIG
```

---

## Setting Up a New Twilio Client

1. Buy a new Twilio number.
2. Set its voice webhook (HTTP POST) to `https://your-domain.com/xml`.
3. Update the outbound caller ID in `app.ts` (`callSomeone` → `from: '+1XXXXXXXXXX'`).
4. Pass the appropriate `AgentConfig` when creating the `Call` instance.
5. If using Calendly, ensure `booking.eventName` matches the exact Calendly event name.

---

## Project Structure

```
src/
  types/index.ts     — AgentConfig, FieldDefinition, BookingConfig, example configs
  Call.ts            — main call handler
  BrainService.ts    — Gemini LLM brain (dynamic schema + prompt)
  ToolCall.ts        — validateTimeSlot, handleAppointment, getAvailability
  Voices.ts          — Google TTS + STT
  Calendly.ts        — Calendly availability + scheduling
  StreamParser.ts    — streaming JSON parser for Gemini responses
app.ts               — Express server + Twilio WebSocket handler
simulate_call.ts     — automated test runner
utils.js             — email outreach utilities
tsconfig.json
```
