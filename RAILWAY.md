# Railway voice bridge

This service connects Twilio Media Streams to GPT-Live and posts completed call reports to the main Care Agent app. It has no Emergent runtime dependency.

## Configuration

- `OPENAI_API_KEY`: existing OpenAI key.
- `OPENAI_VOICE_API`: `live` (default). Set `realtime` explicitly to roll back to the previous protocol; there is no silent model fallback.
- `OPENAI_LIVE_MODEL`: `gpt-live-1` (default).
- `OPENAI_LIVE_BACKEND_MODEL`: `gpt-5.6-luna` (default), used for Responses delegation of agency rules and urgency guidance.
- `OPENAI_LIVE_VOICE`: `vesper` (default), OpenAI's British-influenced voice. Instructions also request British English; accent fidelity still needs a phone test.
- `OPENAI_REALTIME_MODEL`: legacy rollback model, currently `gpt-realtime-2025-08-28`; ignored in Live mode.
- `CAREGENIE_SYSTEM_PROMPT`: existing triage instructions.
- `CALL_REPORT_URL`: `https://careagentnew-production.up.railway.app/api/webhooks/calls/report`.
- `CALL_REPORT_SECRET`: same value as the main app.
- `TWILIO_AUTH_TOKEN`: the primary token for the Twilio account owning the phone numbers.
- `TWILIO_ACCOUNT_SID`: that account's AC identifier, required in Live mode to end the current call.
- `TWILIO_STREAM_WSS_URL`: `wss://careagent-stream-production.up.railway.app/stream`; defaults to Railway's public domain plus `/stream`.
- Optional `OPENAI_VOICE` (ballad), `TRANSCRIPTION_MODEL` (whisper-1), and `PORT` (8080).

The Dockerfile builds with a locked npm dependency graph and runs as an unprivileged user. Keep one replica during the initial cutover. `/health` checks that the process is alive; `/ready` returns 503 until required settings are present. Both expose configuration readiness, selected protocol/model and missing variable names, never secrets. They do not test paid model access, agency mappings or alert delivery. Missing configuration disables all media upgrades. A successful deployment alone does not prove a working phone call.

Twilio must use the main app's `/api/webhooks/twilio/voice` endpoint, which supplies metadata in nested TwiML `Parameter` elements. The bridge validates the Twilio handshake signature against its configured public WSS URL before accepting the socket, then validates the start metadata before opening OpenAI. Query-string metadata is not supported. The main app must also have `TWILIO_AUTH_TOKEN` to authenticate voice/SMS callbacks.

## Protocol and reports

Live connects to `wss://api.openai.com/v1/live/sessions`, starts `gpt-live-1` in `session.start` and waits for `session.started`. Audio is continuous 8 kHz PCMU in both directions, without resampling or Realtime's commit/response-create loop. Input queued during a cold start is bounded to five seconds and paced at the sample rate. Greeting instructions are acknowledged separately; acknowledgment does not prove that the caller heard them.

The main app calls `POST /calls/prepare` after validating the Twilio webhook and resolving the called number to an agency. This request uses `X-Call-Report-Secret` and the exact agency/call/from/to/name metadata. The bridge initializes that call's Live session before Twilio starts its audio stream, then returns a random one-use preparation token. The app supplies it with the same metadata in nested Stream parameters. On attachment, the bridge checks the complete binding and reuses the ready connection instead of building up caller audio during OpenAI initialization. Initial setup moves before the phone's conversational audio; it does not remove provider setup time or promise zero latency.

Preparations are limited to 16 pending sessions, a four-second setup deadline and a 20-second attachment lease. Unused sessions receive session.close and have a bounded forced cleanup. Recent consumed tokens/call IDs cannot open another preparation. There is no always-on paid session pool; each preparation follows an actual authenticated incoming call. A failed or expired preparation falls back to the cold path with the caller's early audio intact. No speech is dropped or accelerated. Use one bridge replica: the preparation cache is in memory, so a restart, rolling deployment or routing to another replica can fall back to cold setup. Scale-out would need shared routing/state. Deploy the bridge first, then the main app.

The audio clock uses cumulative sample deadlines so timer overhead does not add latency to every frame. Only leading startup frames containing exclusively the two digital-zero PCMU codes are trimmed; all nonzero samples and later pauses are preserved. Voice instructions avoid backend delegation for acknowledgments and simple clarifications. Delegated reasoning uses low effort and concise output.

Content-free `live_session_end` metrics include startup/first-output timing, input queue duration, Twilio playback-mark acknowledgment delay, delegation count and up to 100 caller-end/assistant-start transcript gaps. Transcript gaps can include backchannels and transcription timing; playback acknowledgments include network transit and the marked audio duration. These are diagnostics rather than pure model latency. No audio or transcript is logged. Real phone tests are still required to assess conversational responsiveness.

The greeting uses the agency resolved by the called number: for example, "Hello, you're through to Vanguard Care's out-of-hours service. How can I help?" The name is supplied as data in both voice and delegated backend instructions, overriding legacy product branding. Missing names use "the out-of-hours service" rather than inventing a brand. It does not volunteer an AI introduction; the assistant must answer honestly if asked whether it is automated and cannot claim to be human or a clinician. Short voice instructions avoid repeated questions and acknowledgments, accept "this number" for callback, and ask about urgency once unless new information changes it. The existing agency prompt is supplied to the delegated Responses backend. Explicit implementation instructions override legacy `save_call_report` claims: reporting and alert processing happen after hang-up, and the voice must not claim successful delivery. The main app remains responsible for classification and notification execution.

The additional `prepared_session`, `preparation_ms` and `input_queue_at_ready_ms` metrics separate pre-answer setup from queued caller audio. The existing last_input_queue_ms is measured after final draining; it must not be used as evidence that there was no queue during the call. Preparation tokens and shared secrets are never logged.

The only in-call tool is `end_call`. The backend may request it after an explicit goodbye or after the caller confirms they have nothing more to add at the end of intake. Silence, complaints, and mid-conversation thanks must not trigger it. The bridge waits for the completed Responses lifecycle, requires a quote matching the whole latest caller utterance, rejects a stale caller version and deduplicates tool calls. New caller transcript content during a 750 ms closing grace cancels the action. Recognition depends on model/transcript accuracy; a delayed transcript can arrive after a phone update is already in flight.

On confirmation the bridge updates only the authenticated current Twilio Call resource with a fixed British `Polly.Brian` goodbye followed by `<Hangup/>`. The final phrase uses Twilio speech, so its voice differs from GPT-Live. Replacing TwiML avoids the main app's post-Stream fallback redirect; merely closing the WebSocket would wrongly forward a completed call. The five-second request does not follow redirects or retry an uncertain speech update. If rejected, the live conversation remains available and the caller is told they may hang up. Reports still finalize once, including late transcripts. The final Twilio-rendered phrase is not inserted into GPT-Live's transcript as if it was observed audio. `call_end_request` logs provider acceptance, not proof that the goodbye was heard.

Caller and assistant transcript deltas are retained separately, deduplicated by event ID and grouped by their timestamps without trimming or inventing spaces. Backend response text is never treated as spoken transcript. On hang-up, queued caller audio drains, the bridge sends `session.close`, and final transcripts remain accepted until `session.closed` (15-second timeout). Transport loss, backend failure or incomplete finalization produces an urgent report. Usage snapshots are cumulative; logs record the final seconds rather than summing snapshots. Live recording storage is explicitly disabled. Realtime rollback retains the previous GA protocol and two-second transcript grace period.

Report delivery has an 8-second timeout and up to three attempts for transient failures. Retries retain the call ID, allowing the main app to deduplicate them. Permanent rejections and exhausted retries are logged without transcript/response bodies. The bridge still buffers active-call transcripts and pending report retries in memory: process termination or an outage longer than the retry window can lose a report. A persistent bridge outbox is follow-up work; the main application's processing/alert queue becomes durable after it accepts the report.

Before directing real traffic: preserve/import agency data, supply Twilio credentials, verify `/ready`, then perform an authorized test call and verify two-way audio, the stored report and provider-accepted alerts. Long calls, caller interruption/playback alignment and failure recovery also need real-provider testing. Do not treat synthetic tests as proof of end-to-end readiness.

## Tests

`npm ci` and `npm test` run local WebSocket tests with a fake OpenAI endpoint and report sink. No phone calls or paid OpenAI requests are made.

GPT-Live costs $0.05 per minute as documented on 11 September 2026; delegated model usage and Twilio charges are additional. Verify the current price and project access before a call test.

Sources: [Twilio Stream parameters](https://www.twilio.com/docs/voice/twiml/stream), [Twilio request signatures](https://www.twilio.com/docs/usage/security), [GPT-Live](https://developers.openai.com/api/docs/guides/live), [Live WebSockets](https://developers.openai.com/api/docs/guides/voice-websockets?api=live), [Live lifecycle and transcripts](https://developers.openai.com/api/docs/guides/live-conversations), [Delegation](https://developers.openai.com/api/docs/guides/live-delegation), [GPT-Live pricing](https://developers.openai.com/api/docs/models/gpt-live-1).
