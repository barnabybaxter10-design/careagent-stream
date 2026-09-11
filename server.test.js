import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { test } from "node:test";
import { WebSocket } from "ws";
import twilio from "twilio";
import { createBridge, postCallReport, configFromEnv, endTwilioCall } from "./server.js";
import { liveSessionStart, liveGreeting, renderLiveTranscript, isDigitalSilence, nextAudioDeadline,
  validEndCallArguments, greetingText } from "./live.js";

const config = {
  apiKey: "local-test", model: "gpt-realtime-2025-08-28", prompt: "Local test instructions",
  voice: "ballad", transcriptionModel: "whisper-1", reportUrl: "https://app.example/api/webhooks/calls/report",
  reportSecret: "local-report", twilioToken: "local-twilio", streamUrl: "wss://bridge.example/stream",
  twilioAccountSid: `AC${"0".repeat(32)}`,
};
const start = { event: "start", start: {
  callSid: "CA-test", streamSid: "MZ-test",
  customParameters: { agency_id: "agency-a", callSid: "CA-test", from: "+447000000001", to: "+447000000002" },
  mediaFormat: { encoding: "audio/x-mulaw", sampleRate: 8000, channels: 1 },
} };
const until = async predicate => {
  for (let i = 0; i < 500; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("Timed out waiting for local test event");
};
class FakeOpenAI extends EventEmitter {
  readyState = WebSocket.CONNECTING;
  sent = [];
  send(raw) { this.sent.push(JSON.parse(raw)); }
  message(value) { this.emit("message", Buffer.from(JSON.stringify(value))); }
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  close() { this.readyState = WebSocket.CLOSED; this.emit("close"); }
  terminate() { this.close(); }
}
async function fixture(t, extra = {}) {
  const upstreams = [], reports = [];
  const bridge = createBridge({ config, drainMs: 30, setupMs: 200,
    logger: { info() {}, error() {} },
    connectOpenAI: () => { const ws = new FakeOpenAI(); upstreams.push(ws); return ws; },
    report: async payload => { reports.push(payload); return { ok: true, status: 200 }; },
    ...extra,
  });
  bridge.server.listen(0, "127.0.0.1");
  await once(bridge.server, "listening");
  const address = `127.0.0.1:${bridge.server.address().port}`;
  t.after(async () => {
    for (const client of bridge.wss.clients) client.terminate();
    bridge.wss.close();
    await new Promise(resolve => bridge.server.close(resolve));
  });
  async function connect(signatureUrl = config.streamUrl) {
    const ws = new WebSocket(`ws://${address}/stream`, { headers: {
      "X-Twilio-Signature": twilio.getExpectedTwilioSignature(config.twilioToken, signatureUrl, {}),
    } });
    await once(ws, "open");
    t.after(() => ws.terminate());
    return ws;
  }
  return { ...bridge, address, connect, upstreams, reports };
}

test("unsigned or incorrectly signed handshakes never open a paid connection", async t => {
  const f = await fixture(t);
  for (const signature of ["", "incorrect"]) {
    const ws = new WebSocket(`ws://${f.address}/stream`, { headers: { "X-Twilio-Signature": signature } });
    const error = await new Promise(resolve => ws.once("error", resolve));
    assert.match(error.message, /403/);
  }
  assert.equal(f.upstreams.length, 0);
});

test("missing credentials expose readiness failure and refuse media", async t => {
  const f = await fixture(t, { config: { ...config, twilioToken: "" } });
  const health = await fetch(`http://${f.address}/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ready, false);
  assert.equal((await fetch(`http://${f.address}/ready`)).status, 503);
  const ws = new WebSocket(`ws://${f.address}/stream`);
  const error = await new Promise(resolve => ws.once("error", resolve));
  assert.match(error.message, /503/);
  assert.equal(f.upstreams.length, 0);
});

test("Twilio custom parameters, GA audio, late caller transcript and a single report", async t => {
  const f = await fixture(t);
  const ws = await f.connect();
  const received = [];
  ws.on("message", raw => received.push(JSON.parse(raw)));
  assert.equal(f.upstreams.length, 0);
  ws.send(JSON.stringify(start));
  const payload = Buffer.alloc(160, 255).toString("base64");
  ws.send(JSON.stringify({ event: "media", media: { payload } }));
  await until(() => f.upstreams.length === 1);
  const ai = f.upstreams[0]; ai.open();
  const session = ai.sent[0].session;
  assert.equal(session.type, "realtime");
  assert.deepEqual(session.output_modalities, ["audio"]);
  assert.equal(session.audio.input.format.type, "audio/pcmu");
  assert.equal(session.audio.output.format.type, "audio/pcmu");
  assert.equal(session.audio.input.transcription.model, "whisper-1");
  assert.equal(ai.sent.length, 1, "wait for session.updated before greeting/audio");
  ai.message({ type: "session.updated" });
  await until(() => ai.sent.some(event => event.type === "input_audio_buffer.append"));
  assert.equal(ai.sent.find(event => event.type === "input_audio_buffer.append").audio, payload);
  ai.message({ type: "response.output_audio.delta", delta: payload });
  ai.message({ type: "response.output_audio_transcript.done", item_id: "a1", transcript: "How can I help?" });
  ai.message({ type: "input_audio_buffer.speech_started" });
  ai.message({ type: "input_audio_buffer.committed", item_id: "u1" });
  await until(() => received.length === 2);
  assert.deepEqual(received, [{ event: "media", streamSid: "MZ-test", media: { payload } }, { event: "clear", streamSid: "MZ-test" }]);
  ws.send(JSON.stringify({ event: "stop" }));
  await new Promise(resolve => setTimeout(resolve, 10));
  ai.message({ type: "conversation.item.input_audio_transcription.completed", item_id: "u1", transcript: "The carer has not arrived." });
  await until(() => f.reports.length === 1);
  assert.equal(f.reports[0].agency_id, "agency-a");
  assert.equal(f.reports[0].callSid, "CA-test");
  assert.equal(f.reports[0].to, "+447000000002");
  assert.match(f.reports[0].transcript, /Caller: The carer has not arrived\./);
  assert.match(f.reports[0].transcript, /Assistant: How can I help\?/);
  assert.equal(f.reports[0].reason, "twilio_stop");
  ws.close(); ai.close();
  assert.equal(f.reports.length, 1);
});

test("invalid start metadata cannot create an OpenAI session", async t => {
  const f = await fixture(t);
  const ws = await f.connect(config.streamUrl + "/");
  const closed = once(ws, "close");
  ws.send(JSON.stringify({ ...start, start: { ...start.start, customParameters: { agency_id: "agency-a", callSid: "CA-other" } } }));
  await closed;
  assert.equal(f.upstreams.length, 0);
  assert.equal(f.reports.length, 0);
});

test("OpenAI failure still submits one urgent report for the correct agency", async t => {
  const f = await fixture(t);
  const ws = await f.connect(); ws.send(JSON.stringify(start));
  await until(() => f.upstreams.length);
  f.upstreams[0].emit("error", new Error("local simulated failure"));
  await until(() => f.reports.length);
  assert.equal(f.reports[0].urgency, "urgent");
  assert.equal(f.reports[0].agency_id, "agency-a");
  assert.equal(f.reports[0].reason, "openai_error");
});

test("report retry keeps payload identity and does not follow credential redirects", async () => {
  const requests = [];
  const payload = { callSid: "CA-test", agency_id: "agency-a" };
  const result = await postCallReport(payload, config, { sleep: async () => {}, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return new Response(null, { status: requests.length === 1 ? 503 : 200 });
  } });
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.body, requests[1].options.body);
  assert.equal(requests[0].options.redirect, "error");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test("permanent report rejection is reported without pointless retries", async () => {
  let calls = 0;
  const result = await postCallReport({ callSid: "CA-test" }, config, { fetchImpl: async () => {
    calls++; return new Response(null, { status: 401 });
  } });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
});

const liveConfig = { ...config, voiceApi: "live", liveModel: "gpt-live-1", liveVoice: "marin", backendModel: "gpt-5.6-luna" };

test("Live defaults preserve agency guidance without inventing tool execution", () => {
  const settings = configFromEnv({ CAREGENIE_SYSTEM_PROMPT: "Agency policy" });
  const session = liveSessionStart(settings).session;
  assert.equal(settings.voiceApi, "live");
  assert.equal(session.model, "gpt-live-1");
  assert.equal(session.store, false);
  assert.deepEqual(session.audio.format, { type: "audio/pcmu", rate: 8000 });
  assert.match(session.delegation.responses.instructions, /Agency policy/);
  assert.match(session.delegation.responses.instructions, /Do not call or simulate save_call_report/);
  assert.equal(session.audio.output.voice, "vesper");
  assert.equal(session.delegation.responses.tool_choice, "auto");
  assert.deepEqual(session.delegation.responses.tools.map(t => t.name), ["end_call"]);
  assert.match(liveGreeting().content, /the out-of-hours service. How can I help/);
  assert.ok(!liveGreeting().content.includes("I’m an AI"));
  assert.match(session.instructions, /honestly explain/);
});

test("Live streams paced PCMU, handles greeting acknowledgment and final late transcripts", async t => {
  const f = await fixture(t, { config: liveConfig, liveCloseMs: 300 });
  const ws = await f.connect(), received = [];
  ws.on("message", raw => received.push(JSON.parse(raw)));
  ws.send(JSON.stringify(start));
  const payload = Buffer.alloc(160, 128).toString("base64");
  for (let i = 0; i < 3; i++) ws.send(JSON.stringify({ event: "media", media: { payload } }));
  await until(() => f.upstreams.length);
  const ai = f.upstreams[0]; ai.open();
  assert.equal(ai.sent[0].type, "session.start");
  assert.equal(ai.sent.length, 1);
  ai.message({ type: "session.started", event_id: "started" });
  assert.equal(ai.sent.filter(e => e.type === "session.input_audio.append").length, 1, "startup queue is paced");
  assert.equal(ai.sent.filter(e => e.type === "session.commentary.append").length, 0);
  ai.message({ type: "session.instructions.appended", client_event_id: "other" });
  assert.equal(ai.sent.filter(e => e.type === "session.commentary.append").length, 0);
  ai.message({ type: "session.instructions.appended", client_event_id: "care_greeting" });
  assert.equal(ai.sent.filter(e => e.type === "session.commentary.append").length, 1);
  ai.message({ type: "session.output_audio.delta", delta: payload });
  const fragment = { type: "session.input_transcript.delta", event_id: "u1", delta: "The carer", start_ms: 100, end_ms: 400 };
  ai.message(fragment); ai.message(fragment);
  ai.message({ type: "session.output_transcript.delta", event_id: "a1", delta: "I’m listening.", start_ms: 200, end_ms: 450 });
  ai.message({ type: "response.event", event: { type: "response.output_text.delta", delta: "INTERNAL BACKEND TEXT" } });
  ai.message({ type: "session.usage.updated", usage: { seconds: 10 } });
  ai.message({ type: "session.usage.updated", usage: { seconds: 12 } });
  ws.send(JSON.stringify({ event: "stop" }));
  await until(() => ai.sent.some(e => e.type === "session.close"));
  assert.equal(ai.sent.filter(e => e.type === "session.input_audio.append").length, 3);
  assert.equal(f.reports.length, 0, "wait for finalization, not a fixed transcript sleep");
  ai.message({ type: "session.input_transcript.delta", event_id: "u2", delta: " has not arrived.", start_ms: 400, end_ms: 650 });
  ai.message({ type: "session.closed", reason: "close_requested", usage: { seconds: 13 } });
  await until(() => f.reports.length === 1);
  assert.equal(f.reports[0].transcript, "Caller: The carer has not arrived.\nAssistant: I’m listening.");
  assert.equal(f.reports[0].reason, "twilio_stop");
  assert.equal(f.reports[0].urgency, undefined);
  assert.deepEqual(received[0], { event: "media", streamSid: "MZ-test", media: { payload } });
  assert.ok(!ai.sent.some(e => ["response.create", "input_audio_buffer.commit", "session.update"].includes(e.type)));
  ai.close(); ws.close();
  assert.equal(f.reports.length, 1);
});

for (const failure of ["transport", "timeout", "backend"]) {
  test(`Live ${failure} failure creates exactly one urgent report`, async t => {
    const f = await fixture(t, { config: liveConfig, liveCloseMs: 30 });
    const ws = await f.connect(); ws.send(JSON.stringify(start));
    await until(() => f.upstreams.length);
    const ai = f.upstreams[0]; ai.open(); ai.message({ type: "session.started" });
    ai.message({ type: "session.instructions.appended", client_event_id: "care_greeting" });
    ai.message({ type: "session.input_transcript.delta", delta: "Hello", start_ms: 0, end_ms: 200 });
    if (failure === "transport") ai.close();
    else if (failure === "backend") ai.message({ type: "response.event", event: { type: "response.failed" } });
    else ws.send(JSON.stringify({ event: "stop" }));
    await until(() => f.reports.length);
    assert.equal(f.reports[0].urgency, "urgent");
    ai.close(); ws.close();
    assert.equal(f.reports.length, 1);
  });
}

test("Live late overlapping transcript fragments retain spaces and repeated words", () => {
  assert.equal(renderLiveTranscript([
    { role: "Caller", text: " no", start: 200, end: 300, order: 0 },
    { role: "Assistant", text: "Okay.", start: 100, end: 300, order: 1 },
    { role: "Caller", text: "No,", start: 0, end: 200, order: 2 },
    { role: "Caller", text: "More.", start: 5000, end: 5500, order: 3 },
  ]), "Caller: No, no\nAssistant: Okay.\nCaller: More.");
});

test("sample clock prevents cumulative timer drift and bounds catch-up after a stall", () => {
  let deadline = nextAudioDeadline(null, 160, 0);
  for (let i = 0; i < 1000; i++) {
    const callbackTime = deadline + 2; // Every callback arrives two milliseconds late.
    deadline = nextAudioDeadline(deadline, 160, callbackTime);
  }
  assert.equal(deadline, 20020, "two milliseconds of scheduler delay must not accumulate per frame");
  assert.ok(nextAudioDeadline(deadline, 160, 30000) >= 29980, "no unbounded burst after a long stall");
});

test("only digital zero samples count as removable startup silence", () => {
  assert.equal(isDigitalSilence(Buffer.from([255, 127, 255]).toString("base64")), true);
  assert.equal(isDigitalSilence(Buffer.from([255, 254, 255]).toString("base64")), false, "preserve even very quiet nonzero samples");
  assert.equal(isDigitalSilence(""), false);
});

test("startup silence is trimmed without dropping caller speech or later pauses", async t => {
  const logs = [];
  const f = await fixture(t, { config: liveConfig, liveCloseMs: 300,
    logger: { info: line => logs.push(JSON.parse(line)), error() {} } });
  const ws = await f.connect(), silence = Buffer.alloc(160, 255).toString("base64"), speech = Buffer.alloc(160, 254).toString("base64");
  ws.send(JSON.stringify(start));
  for (const payload of [silence, silence, speech, silence]) ws.send(JSON.stringify({ event: "media", media: { payload } }));
  await until(() => f.upstreams.length);
  const ai = f.upstreams[0]; ai.open(); ai.message({ type: "session.started" });
  ai.message({ type: "session.instructions.appended", client_event_id: "care_greeting" });
  await until(() => ai.sent.filter(e => e.type === "session.input_audio.append").length === 2);
  assert.deepEqual(ai.sent.filter(e => e.type === "session.input_audio.append").map(e => e.audio), [speech, silence]);
  const received = [];
  ws.on("message", raw => received.push(JSON.parse(raw)));
  ai.message({ type: "session.output_audio.delta", delta: Buffer.alloc(1600, 128).toString("base64") });
  await until(() => received.some(e => e.event === "mark"));
  ws.send(JSON.stringify({ event: "mark", mark: received.find(e => e.event === "mark").mark }));
  ws.send(JSON.stringify({ event: "stop" }));
  await until(() => ai.sent.some(e => e.type === "session.close"));
  ai.message({ type: "session.closed", reason: "close_requested", usage: { seconds: 1 } });
  await until(() => f.reports.length);
  const metrics = logs.find(e => e.event === "live_session_end");
  assert.equal(metrics.trimmed_startup_silence_ms, 40);
  assert.equal(metrics.last_input_queue_ms, 0);
  assert.ok(metrics.last_playback_ack_ms >= 0);
  assert.ok(!JSON.stringify(metrics).includes(speech), "timing logs contain no audio or transcript");
});

function requestEndCall(ai, { quote = "No, that's everything.", delegation = "delegation_end", completed = true } = {}) {
  ai.message({ type: "response.event", delegation_id: delegation, event: { type: "response.created", response: { id: "response_end" } } });
  ai.message({ type: "response.event", delegation_id: delegation, event: { type: "response.output_item.done", item: {
    type: "function_call", call_id: "end_1", name: "end_call",
    arguments: JSON.stringify({ reason: "intake_finished", caller_confirmation: quote }),
  } } });
  if (completed) ai.message({ type: "response.event", delegation_id: delegation, event: { type: "response.completed", response: { output: [] } } });
}

async function closingFixture(t, extra = {}) {
  const calls = [];
  const f = await fixture(t, { config: liveConfig, endCallGraceMs: 35, liveCloseMs: 100,
    endCall: async meta => { calls.push(meta); return { ok: true, status: 200 }; }, ...extra });
  const ws = await f.connect(); ws.send(JSON.stringify(start));
  await until(() => f.upstreams.length);
  const ai = f.upstreams[0]; ai.open(); ai.message({ type: "session.started" });
  ai.message({ type: "session.instructions.appended", client_event_id: "care_greeting" });
  ai.message({ type: "session.input_transcript.delta", delta: "No, that's everything.", start_ms: 1000, end_ms: 1500 });
  return { ...f, ai, ws, calls };
}

test("end call quotes must match the whole latest caller utterance", () => {
  assert.equal(validEndCallArguments({ reason: "caller_goodbye", caller_confirmation: "Goodbye" }, "Goodbye."), true);
  assert.equal(validEndCallArguments({ reason: "caller_goodbye", caller_confirmation: "Goodbye" }, "Goodbye? No, wait, I need help."), false);
  assert.equal(validEndCallArguments({ reason: "silence", caller_confirmation: "No" }, "No"), false);
  assert.equal(validEndCallArguments({ reason: "intake_finished", caller_confirmation: "" }, ""), false);
});

test("confirmed end waits for completed tool response, replaces only current call and reports once", async t => {
  const f = await closingFixture(t);
  requestEndCall(f.ai, { completed: false });
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.calls.length, 0, "do not execute partially streamed tool calls");
  f.ai.message({ type: "response.event", delegation_id: "delegation_end", event: { type: "response.completed", response: { output: [] } } });
  await until(() => f.calls.length);
  assert.equal(f.calls[0].callSid, start.start.callSid);
  await until(() => f.ai.sent.some(e => e.type === "session.close"));
  f.ai.message({ type: "session.input_transcript.delta", delta: " Bye.", start_ms: 1500, end_ms: 1600 });
  f.ai.message({ type: "session.closed", reason: "close_requested" });
  await until(() => f.reports.length);
  assert.equal(f.reports[0].reason, "conversation_complete");
  assert.equal(f.reports[0].urgency, undefined);
  assert.match(f.reports[0].transcript, /Bye/);
  requestEndCall(f.ai);
  assert.equal(f.calls.length, 1);
  assert.equal(f.reports.length, 1);
});

test("new caller details during closing grace cancel the hangup", async t => {
  const f = await closingFixture(t);
  requestEndCall(f.ai);
  f.ai.message({ type: "session.input_transcript.delta", delta: "Actually, wait. I need help.", start_ms: 3000, end_ms: 3400 });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.calls.length, 0);
  assert.equal(f.ws.readyState, WebSocket.OPEN);
  assert.ok(f.ai.sent.some(e => e.content?.includes("hangup is cancelled")));
  f.ws.send(JSON.stringify({ event: "stop" }));
  await until(() => f.ai.sent.some(e => e.type === "session.close"));
  f.ai.message({ type: "session.closed", reason: "close_requested" });
});

test("an old confirmation cannot end a call after the caller changes their mind", async t => {
  const f = await closingFixture(t);
  requestEndCall(f.ai, { completed: false });
  f.ai.message({ type: "session.input_transcript.delta", delta: "Please stay on the line.", start_ms: 3000, end_ms: 3400 });
  f.ai.message({ type: "response.event", delegation_id: "delegation_end", event: { type: "response.completed" } });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(f.calls.length, 0);
  assert.ok(f.ai.sent.some(e => e.item?.output?.includes("rejected_stale")));
  f.ws.send(JSON.stringify({ event: "stop" }));
  await until(() => f.ai.sent.some(e => e.type === "session.close"));
  f.ai.message({ type: "session.closed", reason: "close_requested" });
});

test("Twilio call-ending rejection leaves the conversation connected", async t => {
  const f = await closingFixture(t, { endCall: async () => ({ ok: false, status: 503 }) });
  requestEndCall(f.ai);
  await until(() => f.ai.sent.some(e => e.content?.includes("call-ending action failed")));
  assert.equal(f.ws.readyState, WebSocket.OPEN);
  assert.equal(f.reports.length, 0);
  f.ws.send(JSON.stringify({ event: "stop" }));
  await until(() => f.ai.sent.some(e => e.type === "session.close"));
  f.ai.message({ type: "session.closed", reason: "close_requested" });
});

test("Twilio goodbye request is scoped, bounded and cannot redirect credentials", async () => {
  const requests = [], meta = { callSid: `CA${"1".repeat(32)}` };
  const result = await endTwilioCall(meta, config, { fetchImpl: async (url, options) => {
    requests.push({ url, options }); return new Response(null, { status: 200 });
  } });
  assert.equal(result.ok, true);
  assert.ok(requests[0].url.endsWith(`/Calls/${meta.callSid}.json`));
  assert.equal(requests[0].options.redirect, "error");
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  const twiml = new URLSearchParams(requests[0].options.body).get("Twiml");
  assert.match(twiml, /language="en-GB"/);
  assert.match(twiml, /Goodbye.<\/Say><Hangup\/>/);
  assert.ok(!twiml.includes("Redirect"));
  await endTwilioCall({ callSid: "../../other-account" }, config, { fetchImpl: async () => { throw new Error("Must not fetch"); } });
  assert.equal(requests.length, 1);
});

const preparedMeta = { callSid: `CA${"a".repeat(32)}`, agency_id: "agency-a", from: "+447000000001",
  to: "+447000000002", agency_name: "Vanguard Care" };
const preparedStart = token => ({ ...start, start: { ...start.start, callSid: preparedMeta.callSid,
  customParameters: { ...preparedMeta, preparation_token: token } } });
const prepareRequest = (f, meta = preparedMeta, secret = config.reportSecret) => fetch(`http://${f.address}/calls/prepare`, {
  method: "POST", headers: { "Content-Type": "application/json", "X-Call-Report-Secret": secret }, body: JSON.stringify(meta),
});

test("agency greetings are per-call, with a neutral fallback and honest identity", () => {
  const first = liveSessionStart(liveConfig, { agency_name: "Vanguard Care" }).session;
  const second = liveSessionStart(liveConfig, { agency_name: "Oak & Elm Care" }).session;
  assert.match(first.instructions, /Vanguard Care/);
  assert.match(first.delegation.responses.instructions, /Vanguard Care/);
  assert.ok(!second.instructions.includes("Vanguard"));
  assert.match(second.instructions, /Oak & Elm Care/);
  assert.equal(greetingText({ agency_name: "Vanguard Care" }), "Hello, you’re through to Vanguard Care’s out-of-hours service. How can I help?");
  assert.ok(!greetingText().includes("CareGenie"));
  assert.match(first.instructions, /never claim to be human or a clinician/);
});

test("unauthorized or invalid preparation never opens OpenAI", async t => {
  const f = await fixture(t, { config: liveConfig });
  assert.equal((await prepareRequest(f, preparedMeta, "wrong")).status, 401);
  assert.equal((await prepareRequest(f, { ...preparedMeta, callSid: "bad" })).status, 400);
  assert.equal((await prepareRequest(f, { ...preparedMeta, to: "https://other.example" })).status, 400);
  assert.equal(f.upstreams.length, 0);
});

test("preparing before Twilio media eliminates the startup queue and preserves the first audio", async t => {
  const logs = [];
  const f = await fixture(t, { config: liveConfig, preparationSetupMs: 200, preparationTtlMs: 500,
    logger: { info: line => logs.push(JSON.parse(line)), error() {} } });
  const request = prepareRequest(f);
  await until(() => f.upstreams.length);
  const ai = f.upstreams[0]; ai.open();
  assert.match(ai.sent[0].session.instructions, /Vanguard Care/);
  ai.message({ type: "session.started", event_id: "ready_before_phone" });
  const token = (await (await request).json()).preparation_token;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  // A duplicate voice webhook must reuse the prepared connection.
  assert.equal((await (await prepareRequest(f)).json()).preparation_token, token);
  const ws = await f.connect(), speech = Buffer.alloc(160, 128).toString("base64");
  ws.send(JSON.stringify(preparedStart(token)));
  ws.send(JSON.stringify({ event: "media", media: { payload: speech } }));
  await until(() => ai.sent.some(e => e.type === "session.input_audio.append"));
  assert.equal(f.upstreams.length, 1);
  assert.equal(ai.sent.filter(e => e.type === "session.start").length, 1);
  assert.equal((await prepareRequest(f)).status, 409, "a retry after attachment cannot open another paid preparation");
  assert.equal(ai.sent.find(e => e.type === "session.input_audio.append").audio, speech);
  assert.match(ai.sent.find(e => e.event_id === "care_greeting").content, /Vanguard Care/);
  ai.message({ type: "session.instructions.appended", client_event_id: "care_greeting" });
  ai.message({ type: "session.input_transcript.delta", delta: "Hello", start_ms: 100, end_ms: 300 });
  // A consumed ticket cannot open another paid session or interfere with this one.
  const duplicate = await f.connect(), closed = once(duplicate, "close");
  duplicate.send(JSON.stringify(preparedStart(token))); await closed;
  assert.equal(f.upstreams.length, 1);
  assert.equal(ws.readyState, WebSocket.OPEN);
  ws.send(JSON.stringify({ event: "stop" }));
  await until(() => ai.sent.some(e => e.type === "session.close"));
  ai.message({ type: "session.closed", reason: "close_requested" });
  await until(() => f.reports.length);
  const metric = logs.find(e => e.event === "live_session_end");
  assert.equal(metric.prepared_session, true);
  assert.equal(metric.input_queue_at_ready_ms, 0);
  assert.ok(metric.max_input_queue_ms <= 20);
  assert.equal(f.reports[0].agency_id, preparedMeta.agency_id);
});

test("preparation cannot be claimed with another agency, destination or name", async t => {
  const f = await fixture(t, { config: liveConfig, preparationSetupMs: 200, preparationTtlMs: 1000 });
  const request = prepareRequest(f); await until(() => f.upstreams.length);
  const ai = f.upstreams[0]; ai.open(); ai.message({ type: "session.started" });
  const token = (await (await request).json()).preparation_token;
  for (const mismatch of [{ agency_id: "agency-b" }, { to: "+447000000009" }, { agency_name: "Other Care" }]) {
    const ws = await f.connect(), closed = once(ws, "close"), data = preparedStart(token);
    Object.assign(data.start.customParameters, mismatch);
    ws.send(JSON.stringify(data)); await closed;
  }
  assert.equal(f.upstreams.length, 1);
  assert.equal(f.reports.length, 0);
  assert.equal((await prepareRequest(f, { ...preparedMeta, agency_id: "agency-b" })).status, 409);
});

test("preparation failure retains the cold start path and its early caller audio", async t => {
  const f = await fixture(t, { config: liveConfig, preparationSetupMs: 20 });
  const request = prepareRequest(f); await until(() => f.upstreams.length);
  const abandoned = f.upstreams[0];
  assert.equal((await request).status, 503);
  assert.equal(abandoned.readyState, WebSocket.CLOSED);
  const ws = await f.connect(), speech = Buffer.alloc(160, 129).toString("base64");
  ws.send(JSON.stringify(preparedStart(undefined)));
  ws.send(JSON.stringify({ event: "media", media: { payload: speech } }));
  await until(() => f.upstreams.length === 2);
  const ai = f.upstreams[1]; ai.open(); ai.message({ type: "session.started" });
  ai.message({ type: "session.instructions.appended", client_event_id: "care_greeting" });
  await until(() => ai.sent.some(e => e.type === "session.input_audio.append"));
  assert.equal(ai.sent.find(e => e.type === "session.input_audio.append").audio, speech);
  ws.send(JSON.stringify({ event: "stop" }));
  await until(() => ai.sent.some(e => e.type === "session.close"));
  ai.message({ type: "session.closed", reason: "close_requested" });
});

test("unused preparations expire, close their paid session and cannot accumulate", async t => {
  const f = await fixture(t, { config: liveConfig, preparationSetupMs: 100, preparationTtlMs: 25, preparationLimit: 1 });
  const request = prepareRequest(f); await until(() => f.upstreams.length);
  assert.equal((await prepareRequest(f, { ...preparedMeta, callSid: `CA${"b".repeat(32)}` })).status, 429);
  const ai = f.upstreams[0]; ai.open(); ai.message({ type: "session.started" });
  await request;
  await until(() => ai.sent.some(e => e.type === "session.close"));
  ai.message({ type: "session.closed", reason: "close_requested" });
  assert.equal(ai.readyState, WebSocket.CLOSED);
  assert.equal(f.reports.length, 0, "an unattached preparation is not a completed phone call");
});
