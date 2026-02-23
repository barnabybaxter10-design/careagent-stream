// server.js
// Twilio Media Streams (WS) <-> OpenAI Realtime (WS) bridge
// + POST call report to Emergent on end of call.
//
// Required Railway env vars:
// - OPENAI_API_KEY
// - OPENAI_REALTIME_MODEL        (e.g. gpt-realtime-2025-08-28)
// - CAREGENIE_SYSTEM_PROMPT
// - CALL_REPORT_URL              (e.g. https://care-responder.preview.../api/webhooks/calls/report)
// - CALL_REPORT_SECRET           (matches Emergent CALL_REPORT_SECRET)
//
// Optional:
// - OPENAI_VOICE                 (default: ballad)
// - INPUT_AUDIO_FORMAT           (default: g711_ulaw)
// - OUTPUT_AUDIO_FORMAT          (default: g711_ulaw)
// - TRANSCRIPTION_MODEL          (default: whisper-1)
// - DEBUG_OPENAI_EVENTS          ("1" to log OpenAI msg.type during a single call)

import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
const SYSTEM_PROMPT = process.env.CAREGENIE_SYSTEM_PROMPT || "";
const VOICE = process.env.OPENAI_VOICE || "ballad";
const INPUT_AUDIO_FORMAT = process.env.INPUT_AUDIO_FORMAT || "g711_ulaw";
const OUTPUT_AUDIO_FORMAT = process.env.OUTPUT_AUDIO_FORMAT || "g711_ulaw";
const TRANSCRIPTION_MODEL = process.env.TRANSCRIPTION_MODEL || "whisper-1";

const CALL_REPORT_URL = process.env.CALL_REPORT_URL || "";
const CALL_REPORT_SECRET = process.env.CALL_REPORT_SECRET || "";
const DEBUG_OPENAI_EVENTS = process.env.DEBUG_OPENAI_EVENTS === "1";

function ts() {
  return new Date().toISOString();
}
function log(ctx, msg) {
  console.log(`${ts()} [${ctx}] ${msg}`);
}
function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}
function parseQueryFromReq(req) {
  // req.url looks like: /stream?agency_id=...&callSid=...&from=...&to=...
  try {
    const u = new URL(req.url, "http://localhost");
    const q = u.searchParams;
    return {
      agency_id: q.get("agency_id") || null,
      callSid: q.get("callSid") || null,
      from: q.get("from") || null,
      to: q.get("to") || null,
    };
  } catch {
    return { agency_id: null, callSid: null, from: null, to: null };
  }
}

async function postCallReport(payload) {
  if (!CALL_REPORT_URL) return { skipped: true, reason: "missing CALL_REPORT_URL" };
  if (!CALL_REPORT_SECRET) return { skipped: true, reason: "missing CALL_REPORT_SECRET" };

  try {
    const res = await fetch(CALL_REPORT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Call-Report-Secret": CALL_REPORT_SECRET,
      },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    return { ok: res.ok, status: res.status, body: text };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server, path: "/stream" });

function openOpenAI(ctx) {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  ws.on("open", () => {
    log(ctx, `OpenAI WS open (model=${MODEL})`);

    // Session config
    sendJson(ws, {
      type: "session.update",
      session: {
        instructions: SYSTEM_PROMPT,
        voice: VOICE,
        input_audio_format: INPUT_AUDIO_FORMAT,
        output_audio_format: OUTPUT_AUDIO_FORMAT,
        modalities: ["audio", "text"],
        // enable caller transcription (best effort)
        input_audio_transcription: { model: TRANSCRIPTION_MODEL },
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        },
      },
    });

    // Initial greeting so you know outbound audio is working
    sendJson(ws, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"], // IMPORTANT (not ["audio"])
        instructions:
          "Greet the caller briefly and ask how you can help. Keep it calm and professional.",
      },
    });
  });

  ws.on("close", (code, reason) => {
    log(ctx, `OpenAI WS closed: ${code} ${reason?.toString?.() || ""}`);
  });

  ws.on("error", (err) => {
    log(ctx, `OpenAI WS error: ${err.message}`);
  });

  return ws;
}

wss.on("connection", (twilioWs, req) => {
  const ctx = Math.random().toString(16).slice(2, 10);

  if (!OPENAI_API_KEY) {
    log(ctx, "Missing OPENAI_API_KEY env var");
    try { twilioWs.close(1011, "Missing OPENAI_API_KEY"); } catch {}
    return;
  }

  const meta = parseQueryFromReq(req);
  log(ctx, `WS connected meta agency_id=${meta.agency_id} callSid=${meta.callSid} from=${meta.from} to=${meta.to}`);

  let streamSid = null;
  let callSidFromStart = null;

  let openaiWs = null;
  let openaiReady = false;

  let startedAt = Date.now();
  let endedAt = null;
  let finalized = false;

  // Transcript buffering
  const transcriptLines = [];
  let assistantBuf = "";

  // Keep Twilio socket alive
  const twilioPing = setInterval(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.ping();
  }, 25000);

  function cleanup(reason) {
    clearInterval(twilioPing);

    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(1000, reason);
    } catch {}

    try {
      if (twilioWs && twilioWs.readyState === WebSocket.OPEN) twilioWs.close(1000, reason);
    } catch {}

    log(ctx, `cleanup: ${reason} (streamSid=${streamSid || "null"})`);
  }

  function flushAssistantLine() {
    const t = assistantBuf.trim();
    if (t) transcriptLines.push(`Assistant: ${t}`);
    assistantBuf = "";
  }

  async function finalizeAndReport(reason) {
    if (finalized) return;
    finalized = true;

    endedAt = endedAt || Date.now();

    const duration_seconds = Math.max(0, Math.round((endedAt - startedAt) / 1000));

    // Ensure assistant buffer isn’t left dangling
    flushAssistantLine();

    const callSid =
      meta.callSid ||
      callSidFromStart ||
      (streamSid ? `stream_${streamSid}` : `unknown_${ctx}`);

    const payload = {
      agency_id: meta.agency_id,
      callSid,
      streamSid,
      from: meta.from,
      to: meta.to,
      started_at: new Date(startedAt).toISOString(),
      ended_at: new Date(endedAt).toISOString(),
      duration_seconds,
      transcript: transcriptLines.join("\n").trim(),
      summary: null,
      reason,
    };

    const result = await postCallReport(payload);
    log(ctx, `report POST: ${JSON.stringify(result)}`);
  }

  // Connect OpenAI per call
  openaiWs = openOpenAI(ctx);

  openaiWs.on("open", () => {
    openaiReady = true;
  });

  openaiWs.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg) return;

    if (DEBUG_OPENAI_EVENTS && msg.type) {
      // Helpful when figuring out which transcription event your account emits
      log(ctx, `OpenAI event: ${msg.type}`);
    }

    if (msg.type === "error") {
      log(ctx, `OpenAI error: ${JSON.stringify(msg.error || msg)}`);
      return;
    }

    // Caller transcription (best effort)
    if (msg.type === "conversation.item.input_audio_transcription.completed") {
      const text = msg.transcription?.text;
      if (text) transcriptLines.push(`Caller: ${text}`);
    }
    // Some accounts emit these instead — keep them as fallbacks
    if (msg.type === "input_audio_transcription.completed") {
      const text = msg.text || msg.transcription?.text;
      if (text) transcriptLines.push(`Caller: ${text}`);
    }

    // Assistant text buffering (avoid spamming one line per delta)
    if ((msg.type === "response.output_text.delta" || msg.type === "response.text.delta") && msg.delta) {
      assistantBuf += msg.delta;
    }
    if (msg.type === "response.output_text.done" || msg.type === "response.text.done") {
      flushAssistantLine();
    }

    // OpenAI -> Twilio audio delta
    const isResponseDelta = msg.type === "response.audio.delta" && msg.delta;
    const isOutputDelta = msg.type === "output_audio.delta" && msg.delta;

    if ((isResponseDelta || isOutputDelta) && streamSid) {
      sendJson(twilioWs, {
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      });
    }
  });

  openaiWs.on("close", async (code) => {
    openaiReady = false;
    endedAt = endedAt || Date.now();
    await finalizeAndReport(`openai_closed_${code}`);
    cleanup(`openai_closed_${code}`);
  });

  openaiWs.on("error", async () => {
    openaiReady = false;
    endedAt = endedAt || Date.now();
    await finalizeAndReport("openai_error");
    cleanup("openai_error");
  });

  // Twilio -> OpenAI audio
  twilioWs.on("message", async (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg || !msg.event) return;

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      callSidFromStart = msg.start?.callSid || null;
      startedAt = Date.now();
      log(ctx, `[start] streamSid=${streamSid} callSid=${callSidFromStart}`);
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      if (openaiReady && openaiWs?.readyState === WebSocket.OPEN) {
        sendJson(openaiWs, { type: "input_audio_buffer.append", audio: payload });
      }
      return;
    }

    if (msg.event === "stop") {
      log(ctx, `[stop] streamSid=${streamSid}`);
      endedAt = endedAt || Date.now();

      try {
        if (openaiWs?.readyState === WebSocket.OPEN) {
          sendJson(openaiWs, { type: "input_audio_buffer.commit" });
          openaiWs.close(1000, "twilio_stop");
        }
      } catch {}

      await finalizeAndReport("twilio_stop");
      cleanup("twilio_stop");
      return;
    }
  });

  twilioWs.on("close", async (code, reason) => {
    log(ctx, `Twilio WS closed: ${code} ${reason?.toString?.() || ""}`);
    endedAt = endedAt || Date.now();
    await finalizeAndReport("twilio_ws_closed");
    cleanup("twilio_closed");
  });

  twilioWs.on("error", async (err) => {
    log(ctx, `Twilio WS error: ${err.message}`);
    endedAt = endedAt || Date.now();
    await finalizeAndReport("twilio_ws_error");
    cleanup("twilio_error");
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
  console.log(`Health: http://0.0.0.0:${PORT}/health`);
  console.log(`WS path: /stream`);
});
