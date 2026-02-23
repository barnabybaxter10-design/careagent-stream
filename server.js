// server.js
// Twilio Media Streams (WS) <-> OpenAI Realtime (WS) bridge
// Required Railway env vars:
// - OPENAI_API_KEY
// - OPENAI_REALTIME_MODEL  (e.g. gpt-realtime-2025-08-28)
// - CAREGENIE_SYSTEM_PROMPT
// Optional:
// - OPENAI_VOICE (default: ballad)
// - INPUT_AUDIO_FORMAT (default: g711_ulaw)
// - OUTPUT_AUDIO_FORMAT (default: g711_ulaw)

import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
const SYSTEM_PROMPT = process.env.CAREGENIE_SYSTEM_PROMPT || "";
const VOICE = process.env.OPENAI_VOICE || "ballad";

const INPUT_AUDIO_FORMAT = process.env.INPUT_AUDIO_FORMAT || "g711_ulaw";
const OUTPUT_AUDIO_FORMAT = process.env.OUTPUT_AUDIO_FORMAT || "g711_ulaw";

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
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
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
    log(ctx, "OpenAI WS open");

    // Configure the session
    sendJson(ws, {
      type: "session.update",
      session: {
        instructions: SYSTEM_PROMPT,
        voice: VOICE,
        input_audio_format: INPUT_AUDIO_FORMAT,
        output_audio_format: OUTPUT_AUDIO_FORMAT,

        // IMPORTANT: keep modalities valid
        modalities: ["audio", "text"],

        // Let OpenAI detect turns and auto-create responses
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        },
      },
    });

    // IMPORTANT: response.modalities must be ["audio","text"], NOT ["audio"]
    sendJson(ws, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions:
          "Greet the caller briefly and ask how you can help. Keep it calm and professional.",
      },
    });
  });

  ws.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg) return;

    if (msg.type === "error") {
      log(ctx, `OpenAI error: ${JSON.stringify(msg.error || msg)}`);
      return;
    }
  });

  ws.on("close", (code, reason) => {
    log(ctx, `OpenAI WS closed: ${code} ${reason?.toString?.() || ""}`);
  });

  ws.on("error", (err) => {
    log(ctx, `OpenAI WS error: ${err.message}`);
  });

  return ws;
}

wss.on("connection", (twilioWs) => {
  const ctx = Math.random().toString(16).slice(2, 10);

  if (!OPENAI_API_KEY) {
    log(ctx, "Missing OPENAI_API_KEY env var");
    try {
      twilioWs.close(1011, "Missing OPENAI_API_KEY");
    } catch {}
    return;
  }

  let streamSid = null;
  let callSid = null;

  let openaiWs = null;
  let openaiReady = false;

  let twilioMediaCount = 0;
  let openaiAudioCount = 0;

  // Keep Twilio socket alive
  const twilioPing = setInterval(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.ping();
  }, 25000);

  function cleanup(reason) {
    clearInterval(twilioPing);

    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close(1000, reason);
      }
    } catch {}

    try {
      if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.close(1000, reason);
      }
    } catch {}

    log(ctx, `cleanup: ${reason} (streamSid=${streamSid || "null"})`);
  }

  // Connect OpenAI immediately (per call)
  openaiWs = openOpenAI(ctx);

  openaiWs.on("open", () => {
    openaiReady = true;
  });

  // OpenAI -> Twilio audio
  openaiWs.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg) return;

    // Most common event names for audio deltas:
    // - response.audio.delta   (msg.delta)
    // Some setups also emit output_audio.delta (msg.delta)
    const isResponseDelta = msg.type === "response.audio.delta" && msg.delta;
    const isOutputDelta = msg.type === "output_audio.delta" && msg.delta;

    if ((isResponseDelta || isOutputDelta) && streamSid) {
      openaiAudioCount++;
      if (openaiAudioCount % 50 === 0) {
        log(ctx, `OUTBOUND AUDIO CHUNKS: ${openaiAudioCount}`);
      }

      sendJson(twilioWs, {
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      });
    }

    if (msg.type === "error") {
      log(ctx, `OpenAI error: ${JSON.stringify(msg.error || msg)}`);
    }
  });

  openaiWs.on("close", (code) => {
    openaiReady = false;
    cleanup(`openai_closed_${code}`);
  });

  openaiWs.on("error", () => {
    openaiReady = false;
    cleanup("openai_error");
  });

  // Twilio -> OpenAI audio
  twilioWs.on("message", (raw) => {
    const msg = safeJsonParse(raw.toString());
    if (!msg || !msg.event) return;

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;

      log(ctx, `[start] streamSid=${streamSid} callSid=${callSid}`);
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      twilioMediaCount++;
      if (twilioMediaCount % 50 === 0) {
        log(ctx, `INBOUND MEDIA FRAMES: ${twilioMediaCount}`);
      }

      if (openaiReady && openaiWs?.readyState === WebSocket.OPEN) {
        sendJson(openaiWs, {
          type: "input_audio_buffer.append",
          audio: payload,
        });
      }
      return;
    }

    if (msg.event === "stop") {
      log(ctx, `[stop] streamSid=${streamSid}`);

      try {
        if (openaiWs?.readyState === WebSocket.OPEN) {
          sendJson(openaiWs, { type: "input_audio_buffer.commit" });
          openaiWs.close(1000, "twilio_stop");
        }
      } catch {}

      cleanup("twilio_stop");
      return;
    }
  });

  twilioWs.on("close", (code, reason) => {
    log(ctx, `Twilio WS closed: ${code} ${reason?.toString?.() || ""}`);
    cleanup("twilio_closed");
  });

  twilioWs.on("error", (err) => {
    log(ctx, `Twilio WS error: ${err.message}`);
    cleanup("twilio_error");
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
  console.log(`Health: http://0.0.0.0:${PORT}/health`);
  console.log(`WS path: /stream`);
});
