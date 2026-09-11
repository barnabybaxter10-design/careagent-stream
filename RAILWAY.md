# Railway voice bridge

This service connects Twilio Media Streams to GPT-Live and posts completed call reports to the main Care Agent app. It has no Emergent runtime dependency.

## Configuration

- `OPENAI_API_KEY`: existing OpenAI key.
- `OPENAI_VOICE_API`: `live` (default). Set `realtime` explicitly to roll back to the previous protocol; there is no silent model fallback.
- `OPENAI_LIVE_MODEL`: `gpt-live-1` (default).
- `OPENAI_LIVE_BACKEND_MODEL`: `gpt-5.6-luna` (default), used for Responses delegation of agency rules and urgency guidance.
- `OPENAI_LIVE_VOICE`: `marin` (default).
- `OPENAI_REALTIME_MODEL`: legacy rollback model, currently `gpt-realtime-2025-08-28`; ignored in Live mode.
- `CAREGENIE_SYSTEM_PROMPT`: existing triage instructions.
- `CALL_REPORT_URL`: `https://careagentnew-production.up.railway.app/api/webhooks/calls/report`.
- `CALL_REPORT_SECRET`: same value as the main app.
- `TWILIO_AUTH_TOKEN`: the primary token for the Twilio account owning the phone numbers.
- `TWILIO_STREAM_WSS_URL`: `wss://careagent-stream-production.up.railway.app/stream`; defaults to Railway's public domain plus `/stream`.
- Optional `OPENAI_VOICE` (ballad), `TRANSCRIPTION_MODEL` (whisper-1), and `PORT` (8080).

The Dockerfile builds with a locked npm dependency graph and runs as an unprivileged user. Keep one replica during the initial cutover. `/health` checks that the process is alive; `/ready` returns 503 until required settings are present. Both expose configuration readiness, selected protocol/model and missing variable names, never secrets. They do not test paid model access, agency mappings or alert delivery. Missing configuration disables all media upgrades. A successful deployment alone does not prove a working phone call.

Twilio must use the main app's `/api/webhooks/twilio/voice` endpoint, which supplies metadata in nested TwiML `Parameter` elements. The bridge validates the Twilio handshake signature against its configured public WSS URL before accepting the socket, then validates the start metadata before opening OpenAI. Query-string metadata is not supported. The main app must also have `TWILIO_AUTH_TOKEN` to authenticate voice/SMS callbacks.

## Protocol and reports

Live connects to `wss://api.openai.com/v1/live/sessions`, starts `gpt-live-1` in `session.start` and waits for `session.started`. Audio is continuous 8 kHz PCMU in both directions, without resampling or Realtime's commit/response-create loop. Input queued during startup is bounded to five seconds and paced at the sample rate. Greeting instructions are acknowledged separately; acknowledgment does not prove that the caller heard them.

Short voice instructions handle conversation and disclosure; the existing agency prompt is supplied to the delegated Responses backend. No private tools execute during the conversation. Explicit implementation instructions override legacy `save_call_report` claims: reporting and alert processing happen after hang-up, and the voice must not claim successful delivery. The main app remains responsible for classification and notification execution.

Caller and assistant transcript deltas are retained separately, deduplicated by event ID and grouped by their timestamps without trimming or inventing spaces. Backend response text is never treated as spoken transcript. On hang-up, queued caller audio drains, the bridge sends `session.close`, and final transcripts remain accepted until `session.closed` (15-second timeout). Transport loss, backend failure or incomplete finalization produces an urgent report. Usage snapshots are cumulative; logs record the final seconds rather than summing snapshots. Live recording storage is explicitly disabled. Realtime rollback retains the previous GA protocol and two-second transcript grace period.

Report delivery has an 8-second timeout and up to three attempts for transient failures. Retries retain the call ID, allowing the main app to deduplicate them. Permanent rejections and exhausted retries are logged without transcript/response bodies. The bridge still buffers active-call transcripts and pending report retries in memory: process termination or an outage longer than the retry window can lose a report. A persistent bridge outbox is follow-up work; the main application's processing/alert queue becomes durable after it accepts the report.

Before directing real traffic: preserve/import agency data, supply Twilio credentials, verify `/ready`, then perform an authorized test call and verify two-way audio, the stored report and provider-accepted alerts. Long calls, caller interruption/playback alignment and failure recovery also need real-provider testing. Do not treat synthetic tests as proof of end-to-end readiness.

## Tests

`npm ci` and `npm test` run local WebSocket tests with a fake OpenAI endpoint and report sink. No phone calls or paid OpenAI requests are made.

GPT-Live costs $0.05 per minute as documented on 11 September 2026; delegated model usage and Twilio charges are additional. Verify the current price and project access before a call test.

Sources: [Twilio Stream parameters](https://www.twilio.com/docs/voice/twiml/stream), [Twilio request signatures](https://www.twilio.com/docs/usage/security), [GPT-Live](https://developers.openai.com/api/docs/guides/live), [Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live), [Live lifecycle and transcripts](https://developers.openai.com/api/docs/guides/live-conversations), [Delegation](https://developers.openai.com/api/docs/guides/live-delegation), [GPT-Live pricing](https://developers.openai.com/api/docs/models/gpt-live-1).
