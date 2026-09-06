# Railway voice bridge

This service connects Twilio Media Streams to OpenAI Realtime and posts completed call reports to the main Care Agent app. It has no Emergent runtime dependency.

## Configuration

- `OPENAI_API_KEY`: existing OpenAI key.
- `OPENAI_REALTIME_MODEL`: preserve the configured model, currently `gpt-realtime-2025-08-28`. Confirm account availability in an authorized live test before accepting calls.
- `CAREGENIE_SYSTEM_PROMPT`: existing triage instructions.
- `CALL_REPORT_URL`: `https://careagentnew-production.up.railway.app/api/webhooks/calls/report`.
- `CALL_REPORT_SECRET`: same value as the main app.
- `TWILIO_AUTH_TOKEN`: the primary token for the Twilio account owning the phone numbers.
- `TWILIO_STREAM_WSS_URL`: `wss://careagent-stream-production.up.railway.app/stream`; defaults to Railway's public domain plus `/stream`.
- Optional `OPENAI_VOICE` (ballad), `TRANSCRIPTION_MODEL` (whisper-1), and `PORT` (8080).

The Dockerfile builds with a locked npm dependency graph and runs as an unprivileged user. Keep one replica during the initial cutover. `/health` checks that the process is alive; `/ready` returns 503 until required settings are present. Both expose a `ready` boolean and missing variable names, never values. Missing configuration disables all media upgrades. A successful deployment alone does not prove a working phone call.

Twilio must use the main app's `/api/webhooks/twilio/voice` endpoint, which supplies metadata in nested TwiML `Parameter` elements. The bridge validates the Twilio handshake signature against its configured public WSS URL before accepting the socket, then validates the start metadata before opening OpenAI. Query-string metadata is not supported. The main app must also have `TWILIO_AUTH_TOKEN` to authenticate voice/SMS callbacks.

## Protocol and reports

The bridge uses Realtime's GA session/audio schema and `audio/pcmu` for Twilio's 8 kHz mu-law audio. It waits for `session.updated` before greeting or forwarding buffered caller audio. It captures `conversation.item.input_audio_transcription.completed.transcript` and `response.output_audio_transcript.done.transcript` and briefly waits for final transcripts on hang-up. Upstream failures or incomplete transcripts produce an urgent report.

Report delivery has an 8-second timeout and up to three attempts for transient failures. Retries retain the call ID, allowing the main app to deduplicate them. Permanent rejections and exhausted retries are logged without transcript/response bodies. The bridge still buffers active-call transcripts and pending report retries in memory: process termination or an outage longer than the retry window can lose a report. A persistent bridge outbox is follow-up work; the main application's processing/alert queue becomes durable after it accepts the report.

Before directing real traffic: preserve/import agency data, supply Twilio credentials, verify `/ready`, then perform an authorized test call and verify two-way audio, the stored report and provider-accepted alerts. Long calls, caller interruption/playback alignment and failure recovery also need real-provider testing. Do not treat synthetic tests as proof of end-to-end readiness.

## Tests

`npm ci` and `npm test` run local WebSocket tests with a fake OpenAI endpoint and report sink. No phone calls or paid OpenAI requests are made.

Sources: [Twilio Stream parameters](https://www.twilio.com/docs/voice/twiml/stream), [Twilio request signatures](https://www.twilio.com/docs/usage/security), [OpenAI Realtime conversations](https://developers.openai.com/api/docs/guides/realtime-conversations).
