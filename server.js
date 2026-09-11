// Twilio Media Streams <-> OpenAI Realtime, hosted on Railway.
import http from "node:http";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import twilio from "twilio";
import { WebSocketServer, WebSocket } from "ws";
import { connectLive, liveSessionStart, liveGreeting, renderLiveTranscript,
  isDigitalSilence, nextAudioDeadline } from "./live.js";

const send = (ws, value) => {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
};

export function configFromEnv(env = process.env) {
  return {
    apiKey: env.OPENAI_API_KEY || "",
    voiceApi: env.OPENAI_VOICE_API || "live",
    liveModel: env.OPENAI_LIVE_MODEL || "gpt-live-1",
    liveVoice: env.OPENAI_LIVE_VOICE || "marin",
    backendModel: env.OPENAI_LIVE_BACKEND_MODEL || "gpt-5.6-luna",
    model: env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28",
    prompt: env.CAREGENIE_SYSTEM_PROMPT || "",
    voice: env.OPENAI_VOICE || "ballad",
    transcriptionModel: env.TRANSCRIPTION_MODEL || "whisper-1",
    reportUrl: env.CALL_REPORT_URL || "",
    reportSecret: env.CALL_REPORT_SECRET || "",
    twilioToken: env.TWILIO_AUTH_TOKEN || "",
    streamUrl: env.TWILIO_STREAM_WSS_URL ||
      (env.RAILWAY_PUBLIC_DOMAIN ? `wss://${env.RAILWAY_PUBLIC_DOMAIN}/stream` : ""),
  };
}

export function missingConfiguration(config) {
  const fields = {
    OPENAI_API_KEY: config.apiKey, CAREGENIE_SYSTEM_PROMPT: config.prompt,
    CALL_REPORT_SECRET: config.reportSecret, TWILIO_AUTH_TOKEN: config.twilioToken,
  };
  const missing = Object.keys(fields).filter(key => !fields[key]);
  if (config.voiceApi && !["live", "realtime"].includes(config.voiceApi)) missing.push("OPENAI_VOICE_API");
  for (const [name, value, protocol] of [
    ["CALL_REPORT_URL", config.reportUrl, "https:"],
    ["TWILIO_STREAM_WSS_URL", config.streamUrl, "wss:"],
  ]) {
    try {
      const url = new URL(value);
      if (url.protocol !== protocol || url.username || url.password ||
          url.search || url.hash || (name === "TWILIO_STREAM_WSS_URL" && url.pathname !== "/stream")) {
        missing.push(name);
      }
    } catch { missing.push(name); }
  }
  return missing;
}

export function validHandshake(req, config) {
  if (req.url !== "/stream" || !config.twilioToken || !config.streamUrl) return false;
  const signature = req.headers["x-twilio-signature"];
  if (typeof signature !== "string") return false;
  // Fixed public URL avoids trusting proxy or Host headers. Twilio documents
  // the optional trailing slash for voice WebSocket signature validation.
  return [config.streamUrl, config.streamUrl + "/"].some(url =>
    twilio.validateRequest(config.twilioToken, signature, url, {}));
}

export function sessionUpdate(config) {
  return {
    type: "session.update",
    session: {
      type: "realtime",
      instructions: config.prompt,
      output_modalities: ["audio"],
      audio: {
        input: {
          format: { type: "audio/pcmu" },
          transcription: { model: config.transcriptionModel },
          turn_detection: {
            type: "server_vad", threshold: 0.5, prefix_padding_ms: 300,
            silence_duration_ms: 500, create_response: true, interrupt_response: true,
          },
        },
        output: { format: { type: "audio/pcmu" }, voice: config.voice },
      },
    },
  };
}

export async function postCallReport(payload, config, {
  fetchImpl = fetch, sleep = delay, attempts = 3, timeoutMs = 8000,
} = {}) {
  let status = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const response = await fetchImpl(config.reportUrl, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { "Content-Type": "application/json", "X-Call-Report-Secret": config.reportSecret },
        body: JSON.stringify(payload),
      });
      status = response.status;
      // Never log report response bodies; they can contain care information.
      await response.body?.cancel();
      if (response.ok) return { ok: true, status, attempts: attempt };
      if (status < 500 && status !== 429 && status !== 408) {
        return { ok: false, status, attempts: attempt };
      }
    } catch { /* A retry uses the same callSid; the receiving app is idempotent. */ }
    if (attempt < attempts) await sleep(500 * 2 ** (attempt - 1));
  }
  return { ok: false, status, attempts };
}

export function createBridge({
  config = configFromEnv(),
  connectOpenAI = () => config.voiceApi === "live" ? connectLive(config) : new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
    { headers: { Authorization: `Bearer ${config.apiKey}` }, handshakeTimeout: 10000 }
  ),
  report = payload => postCallReport(payload, config),
  logger = console,
  drainMs = 2000,
  setupMs = 10000,
  liveCloseMs = 15000,
} = {}) {
  const live = config.voiceApi === "live";
  const missing = missingConfiguration(config);
  const server = http.createServer((req, res) => {
    if (req.url === "/health" || req.url === "/ready") {
      res.writeHead(req.url === "/ready" && missing.length ? 503 : 200,
        { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", ready: missing.length === 0, missing,
        voice_api: live ? "live" : "realtime", model: live ? config.liveModel : config.model,
        ...(live ? { backend_model: config.backendModel } : {}) }));
    } else {
      res.writeHead(404); res.end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const status = missing.length ? 503 : validHandshake(req, config) ? 101 : 403;
    if (status !== 101) {
      socket.end(`HTTP/1.1 ${status} ${status === 503 ? "Service Unavailable" : "Forbidden"}\r\nConnection: close\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit("connection", ws, req));
  });

  wss.on("connection", twilioWs => {
    let meta = null, streamSid = null, openaiWs = null, ready = false;
    let ending = false, reported = false, startedAt = Date.now(), endedAt;
    let audioQueue = [], queuedBytes = 0, uncommittedBytes = 0;
    let drainTimer, setupTimer, maxDurationTimer, audioTimer;
    let uncertain = false;
    let endingReason, liveFinalized = false, closeRequested = false, greetingAccepted = false;
    let usageSeconds = null;
    let nextAudioAt = null, startupMs = null, firstOutputMs = null, trimmedSilenceMs = 0;
    let maxInputQueueMs = 0, lastInputQueueMs = 0, outputSinceMark = 0, markSequence = 0;
    let lastPlaybackAckMs = null, maxPlaybackAckMs = 0;
    const playbackMarks = new Map();
    const liveFragments = [], liveEventIds = new Set();
    const transcripts = new Map();
    const pendingTranscripts = new Set();
    const ping = setInterval(() => {
      if (twilioWs.readyState === WebSocket.OPEN) twilioWs.ping();
    }, 25000);

    function closeSocket(ws) {
      if (ws?.readyState === WebSocket.OPEN) ws.close(1000);
      else if (ws?.readyState === WebSocket.CONNECTING) ws.terminate();
    }
    function appendAudio(payload) {
      if (live) {
        queuedBytes += Buffer.from(payload, "base64").length;
        if (queuedBytes > 8000 * 5) { finish("audio_buffer_overflow", false); return; }
        audioQueue.push(payload);
        maxInputQueueMs = Math.max(maxInputQueueMs, queuedBytes / 8);
        pumpLiveAudio();
        return;
      }
      uncommittedBytes += Buffer.from(payload, "base64").length;
      send(openaiWs, { type: "input_audio_buffer.append", audio: payload });
    }
    function requestLiveClose() {
      if (closeRequested || reported) return;
      closeRequested = true;
      send(openaiWs, { type: "session.close", event_id: "care_session_close" });
      drainTimer = setTimeout(() => {
        uncertain = true; void complete("live_finalize_timeout");
      }, liveCloseMs);
    }
    function pumpLiveAudio() {
      if (audioTimer || !ready || reported || closeRequested) return;
      const payload = audioQueue.shift();
      if (!payload) { nextAudioAt = null; if (ending) requestLiveClose(); return; }
      const bytes = Buffer.from(payload, "base64").length;
      queuedBytes -= bytes;
      lastInputQueueMs = queuedBytes / 8;
      nextAudioAt = nextAudioDeadline(nextAudioAt, bytes, performance.now());
      send(openaiWs, { type: "session.input_audio.append", audio: payload });
      // Startup audio must not be burst into Live faster than its sample rate.
      audioTimer = setTimeout(() => { audioTimer = null; pumpLiveAudio(); }, Math.max(1, nextAudioAt - performance.now()));
    }
    async function complete(reason) {
      if (reported) return;
      reported = true;
      clearTimeout(drainTimer); clearTimeout(setupTimer);
      clearTimeout(audioTimer);
      clearTimeout(maxDurationTimer); clearInterval(ping);
      closeSocket(openaiWs); closeSocket(twilioWs);
      if (!meta) return;
      const transcript = live ? renderLiveTranscript(liveFragments) :
        [...transcripts.values()].map(row => `${row.role}: ${row.text}`).join("\n");
      const payload = {
        agency_id: meta.agency_id, callSid: meta.callSid, streamSid,
        from: meta.from, to: meta.to, started_at: new Date(startedAt).toISOString(),
        ended_at: new Date(endedAt || Date.now()).toISOString(),
        duration_seconds: Math.max(0, Math.round(((endedAt || Date.now()) - startedAt) / 1000)),
        transcript, summary: null, reason,
      };
      const callerCaptured = live ? liveFragments.some(row => row.role === "Caller" && row.text.trim()) :
        [...transcripts.values()].some(row => row.role === "Caller");
      if (uncertain || pendingTranscripts.size || !callerCaptured || (live && !liveFinalized)) {
        payload.urgency = "urgent";
      }
      if (live) logger.info(JSON.stringify({ event: "live_session_end", callSid: meta.callSid,
        finalized: liveFinalized, usage_seconds: usageSeconds, startup_ms: startupMs,
        first_output_ms: firstOutputMs, trimmed_startup_silence_ms: trimmedSilenceMs,
        max_input_queue_ms: maxInputQueueMs, last_input_queue_ms: lastInputQueueMs,
        last_playback_ack_ms: lastPlaybackAckMs, max_playback_ack_ms: maxPlaybackAckMs }));
      try {
        const result = await report(payload);
        (result?.ok ? logger.info : logger.error).call(logger,
          JSON.stringify({ event: "call_report", callSid: meta.callSid, ...result }));
      } catch {
        logger.error(JSON.stringify({ event: "call_report", callSid: meta.callSid, ok: false }));
      }
    }
    function finish(reason, drain = true) {
      if (ending) return;
      ending = true; endedAt = Date.now(); endingReason = reason;
      clearTimeout(setupTimer); clearTimeout(maxDurationTimer);
      if (reason !== "twilio_stop" && reason !== "twilio_closed") uncertain = true;
      if (drain && ready && openaiWs?.readyState === WebSocket.OPEN) {
        if (live) { pumpLiveAudio(); return; }
        // Capture the last caller utterance after hang-up. Avoid committing less
        // than Realtime's minimum 100 ms (800 PCMU bytes).
        if (uncommittedBytes >= 800) send(openaiWs, { type: "input_audio_buffer.commit" });
        drainTimer = setTimeout(() => { void complete(reason); }, drainMs);
      } else { void complete(reason); }
    }
    setupTimer = setTimeout(() => finish("start_timeout", false), setupMs);

    function startOpenAI() {
      try { openaiWs = connectOpenAI(); }
      catch { finish("openai_connect_error", false); return; }
      openaiWs.on("open", () => send(openaiWs, live ? liveSessionStart(config) : sessionUpdate(config)));
      openaiWs.on("message", raw => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        if (reported) return;
        if (live) {
          if (msg.event_id && liveEventIds.has(msg.event_id)) return;
          if (msg.event_id) liveEventIds.add(msg.event_id);
          if (msg.type === "session.started" && !ready && !ending) {
            ready = true; clearTimeout(setupTimer);
            startupMs = Date.now() - startedAt;
            // Retaining old startup silence makes every later utterance late.
            // Preserve all non-silent audio and one final frame to keep input flowing.
            while (audioQueue.length > 1 && isDigitalSilence(audioQueue[0])) {
              const bytes = Buffer.from(audioQueue.shift(), "base64").length;
              queuedBytes -= bytes; trimmedSilenceMs += bytes / 8;
            }
            send(openaiWs, liveGreeting());
            setupTimer = setTimeout(() => finish("live_greeting_timeout", false), setupMs);
            pumpLiveAudio();
          }
          if (msg.type === "session.instructions.appended" && msg.client_event_id === "care_greeting" && !ending && !greetingAccepted) {
            greetingAccepted = true; clearTimeout(setupTimer);
            send(openaiWs, { type: "session.commentary.append", event_id: "care_begin",
              delegation_id: null, content: "Begin the conversation now, following the greeting instructions." });
          }
          if (["session.input_transcript.delta", "session.output_transcript.delta"].includes(msg.type) && typeof msg.delta === "string") {
            liveFragments.push({ role: msg.type === "session.input_transcript.delta" ? "Caller" : "Assistant",
              text: msg.delta, start: Number.isFinite(msg.start_ms) ? msg.start_ms : Date.now() - startedAt,
              end: Number.isFinite(msg.end_ms) ? msg.end_ms : Date.now() - startedAt, order: liveFragments.length });
          }
          if (msg.type === "session.output_audio.delta" && msg.delta && !ending) {
            firstOutputMs ??= Date.now() - startedAt;
            send(twilioWs, { event: "media", streamSid, media: { payload: msg.delta } });
            outputSinceMark += Buffer.from(msg.delta, "base64").length;
            if (outputSinceMark >= 1600) {
              const name = `live_audio_${++markSequence}`;
              playbackMarks.set(name, performance.now()); outputSinceMark = 0;
              if (playbackMarks.size > 500) playbackMarks.delete(playbackMarks.keys().next().value);
              send(twilioWs, { event: "mark", streamSid, mark: { name } });
            }
          }
          if (msg.type === "session.usage.updated" || msg.type === "session.closed") {
            if (Number.isFinite(msg.usage?.seconds)) usageSeconds = msg.usage.seconds;
          }
          if (msg.type === "session.closed") {
            liveFinalized = true;
            if (!ending || !["close_requested", "remote_hangup"].includes(msg.reason)) uncertain = true;
            ending = true;
            void complete(endingReason || `live_${msg.reason || "closed"}`);
          }
          if (msg.type === "error" || (msg.type === "response.event" &&
              ["response.failed", "response.incomplete", "error"].includes(msg.event?.type))) {
            uncertain = true;
            logger.error(JSON.stringify({ event: "live_error", code: msg.error?.code || msg.event?.type || "unknown" }));
            send(twilioWs, { event: "clear", streamSid });
            closeSocket(twilioWs);
            if (ending) { void complete("live_error"); } else finish("live_error");
          }
          return;
        }
        if (msg.type === "session.updated" && !ready && !ending) {
          ready = true; clearTimeout(setupTimer);
          send(openaiWs, { type: "response.create", response: {
            output_modalities: ["audio"],
            instructions: "Greet the caller briefly and ask how you can help. Keep it calm and professional.",
          } });
          for (const payload of audioQueue) appendAudio(payload);
          audioQueue = []; queuedBytes = 0;
        }
        if (msg.type === "input_audio_buffer.committed") {
          uncommittedBytes = 0;
          if (msg.item_id) pendingTranscripts.add(msg.item_id);
        }
        if (msg.type === "conversation.item.input_audio_transcription.completed") {
          pendingTranscripts.delete(msg.item_id);
          if (msg.transcript?.trim()) transcripts.set(msg.item_id, { role: "Caller", text: msg.transcript.trim() });
        }
        if (msg.type === "conversation.item.input_audio_transcription.failed") {
          pendingTranscripts.delete(msg.item_id); uncertain = true;
        }
        if (msg.type === "response.output_audio_transcript.done" && msg.transcript?.trim()) {
          transcripts.set(`assistant:${msg.item_id}:${msg.content_index || 0}`,
            { role: "Assistant", text: msg.transcript.trim() });
        }
        if (msg.type === "response.output_audio.delta" && msg.delta && !ending) {
          send(twilioWs, { event: "media", streamSid, media: { payload: msg.delta } });
        }
        if (msg.type === "input_audio_buffer.speech_started" && !ending) {
          send(twilioWs, { event: "clear", streamSid });
        }
        if (msg.type === "error") {
          // A VAD commit may race the hang-up commit. Empty-buffer is harmless.
          if (ending && msg.error?.code === "input_audio_buffer_commit_empty") return;
          logger.error(JSON.stringify({ event: "openai_error", code: msg.error?.code || "unknown" }));
          finish("openai_error", false);
        }
      });
      openaiWs.on("close", () => {
        ready = false;
        if (live && !liveFinalized) uncertain = true;
        if (ending) { void complete(live ? "live_connection_lost" : endingReason); }
        else finish("openai_closed", false);
      });
      openaiWs.on("error", () => finish("openai_error", false));
    }

    twilioWs.on("message", raw => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { finish("invalid_message", false); return; }
      if (msg.event === "mark" && playbackMarks.has(msg.mark?.name)) {
        lastPlaybackAckMs = Math.round(performance.now() - playbackMarks.get(msg.mark.name));
        maxPlaybackAckMs = Math.max(maxPlaybackAckMs, lastPlaybackAckMs);
        playbackMarks.delete(msg.mark.name);
      }
      if (ending) return;
      if (msg.event === "start") {
        if (meta) { finish("duplicate_start", false); return; }
        const start = msg.start || {}, params = start.customParameters || {};
        if (!params.agency_id || !params.to || !start.callSid || !start.streamSid ||
            params.callSid !== start.callSid ||
            start.mediaFormat?.encoding !== "audio/x-mulaw" ||
            start.mediaFormat?.sampleRate !== 8000 || start.mediaFormat?.channels !== 1) {
          finish("invalid_start", false); return;
        }
        meta = { agency_id: params.agency_id, callSid: start.callSid, from: params.from || "", to: params.to };
        streamSid = start.streamSid; startedAt = Date.now();
        clearTimeout(setupTimer);
        setupTimer = setTimeout(() => finish("openai_setup_timeout", false), setupMs);
        maxDurationTimer = setTimeout(() => finish("duration_limit"), 55 * 60 * 1000);
        startOpenAI();
      } else if (msg.event === "media" && meta && typeof msg.media?.payload === "string") {
        if (ready) appendAudio(msg.media.payload);
        else {
          queuedBytes += Buffer.from(msg.media.payload, "base64").length;
          maxInputQueueMs = Math.max(maxInputQueueMs, queuedBytes / 8);
          if (queuedBytes > 8000 * 5) { finish("audio_buffer_overflow", false); return; }
          audioQueue.push(msg.media.payload);
        }
      } else if (msg.event === "stop") finish("twilio_stop");
    });
    twilioWs.on("close", () => finish("twilio_closed"));
    twilioWs.on("error", () => finish("twilio_error", false));
  });
  return { server, wss };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { server } = createBridge();
  server.listen(process.env.PORT || 8080, "0.0.0.0", () => {
    console.log("Care Agent voice bridge listening");
  });
}
