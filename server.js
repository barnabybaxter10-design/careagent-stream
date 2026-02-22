import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;

// ====== ENV ======
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
const CAREGENIE_SYSTEM_PROMPT =
  process.env.CAREGENIE_SYSTEM_PROMPT || process.env.CAREGENIE_SYSTEM_PROMPT || "";

const OPENAI_VOICE = process.env.OPENAI_VOICE || "ballad";

// Twilio Media Streams audio is typically G.711 u-law @ 8k.
// We try to match that end-to-end for low latency.
const INPUT_AUDIO_FORMAT = process.env.INPUT_AUDIO_FORMAT || "g711_ulaw";
const OUTPUT_AUDIO_FORMAT = process.env.OUTPUT_AUDIO_FORMAT || "g711_ulaw";

// ====== HTTP server ======
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

// ====== WS server (Twilio connects here) ======
const wss = new WebSocketServer({ server, path: "/stream" });

function now() {
  return new Date().toISOString();
}

function log(ctx, msg) {
  console.log(`${now()} [${ctx}] ${msg}`);
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function openaiWsUrl(model) {
  // OpenAI Realtime WebSocket endpoint
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

function makeOpenAIClient(ctx) {
  if (!OPENAI_API_KEY) {
    log(ctx, "Missing OPENAI_API_KEY env var");
    return null;
  }

  const ws = new WebSocket(openaiWsUrl(OPENAI_REALTIME_MODEL), {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  return ws;
}

// Send a JSON event to OpenAI
function sendOpenAI(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Send a JSON event to Twilio
function sendTwilio(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on("connection", (twilioWs) => {
  const ctx = Math.random().toString(16).slice(2, 10);

  let streamSid = null;
  let callSid = null;

  let openaiWs = null;
  let openaiReady = false;

  let gotAnyTwilioMedia = false;
  let sentAnyTwilioMediaToOpenAI = false;
  let gotAnyOpenAIAudio = false;

  // Keep Twilio socket alive
  const pingInterval = setInterval(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.ping();
  }, 25000);

  log(ctx, "Twilio WS connected");

  function cleanup(reason) {
    clearInterval(pingInterval);

    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      try {
        openaiWs.close(1000, reason);
      } catch {}
    }

    if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
      try {
        twilioWs.close(1000, reason);
      } catch {}
    }

    log(ctx, `cleanup: ${reason} (streamSid=${streamSid || "null"})`);
  }

  function ensureOpenAI() {
    if (openaiWs) return;

    openaiWs = makeOpenAIClient(ctx);
    if (!openaiWs) return;

    openaiWs.on("open", () => {
      openaiReady = true;
      log(ctx, "OpenAI WS open");

      // IMPORTANT: Session config so OpenAI knows formats/voice + uses server VAD.
      sendOpenAI(openaiWs, {
        type: "session.update",
        session: {
          instructions: CAREGENIE_SYSTEM_PROMPT,
          voice: OPENAI_VOICE,
          // Low latency voice + audio in/out
          input_audio_format: INPUT_AUDIO_FORMAT,
          output_audio_format: OUTPUT_AUDIO_FORMAT,
          // Let OpenAI detect turns so you don’t have to manually commit each time
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
          },
          // Make sure it can speak
          modalities: ["text", "audio"],
        },
      });

      // Optional: force the assistant to greet immediately.
      // If you don’t want AI to greet first, delete this block.
      sendOpenAI(openaiWs, {
        type: "response.create",
        response: {
          modalities: ["audio"],
          instructions:
            "Start the call now with one gentle opening line from the system instructions, then wait.",
        },
      });
    });

    openaiWs.on("message", (raw) => {
      const msg = safeJsonParse(raw.toString());
      if (!msg) return;

      // Helpful debug
      if (msg.type && msg.type !== "response.audio.delta") {
        // Uncomment if you want more noise:
        // log(ctx, `OpenAI event: ${msg.type}`);
      }

      // OpenAI audio chunks (base64). Relay to Twilio as media payload.
      // Depending on API, this may be "response.audio.delta" or similar.
      const audioDelta =
        msg.delta ||
        msg.audio?.delta ||
        msg.response?.audio?.delta ||
        msg.response?.output_audio?.delta;

      if (audioDelta && streamSid) {
        gotAnyOpenAIAudio = true;
        sendTwilio(twilioWs, {
          event: "media",
          streamSid,
          media: { payload: audioDelta },
        });
      }

      // If OpenAI closes because of an error, it often sends an error event
      if (msg.type === "error") {
        log(ctx, `OpenAI error: ${JSON.stringify(msg.error || msg)}`);
      }
    });

    openaiWs.on("close", (code, reason) => {
      openaiReady = false;
      log(ctx, `OpenAI WS closed: ${code} ${reason?.toString?.() || ""}`);

      // If OpenAI drops, Twilio will be silent. End cleanly.
      cleanup("openai_closed");
    });

    openaiWs.on("error", (err) => {
      openaiReady = false;
      log(ctx, `OpenAI WS error: ${err.message}`);
      cleanup("openai_error");
    });
  }

  twilioWs.on("message", (data) => {
    const msg = safeJsonParse(data.toString());
    if (!msg) return;

    // Twilio events: start, media, stop
    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      log(ctx, `[start] streamSid=${streamSid} callSid=${callSid}`);

      ensureOpenAI();
      return;
    }

    if (msg.event === "media") {
      gotAnyTwilioMedia = true;

      // Twilio gives base64 audio payload:
      // msg.media.payload
      const payload = msg.media?.payload;
      if (!payload) return;

      // Ensure OpenAI is connected
      ensureOpenAI();

      if (openaiWs && openaiReady) {
        sentAnyTwilioMediaToOpenAI = true;

        // Send audio chunk to OpenAI Realtime buffer
        sendOpenAI(openaiWs, {
          type: "input_audio_buffer.append",
          audio: payload,
        });
      }
      return;
    }

    if (msg.event === "stop") {
      log(ctx, `[stop] streamSid=${streamSid}`);

      // Print a quick summary for debugging
      log(
        ctx,
        `summary: twilioMedia=${gotAnyTwilioMedia} sentToOpenAI=${sentAnyTwilioMediaToOpenAI} openAIAudioBack=${gotAnyOpenAIAudio}`
      );

      cleanup("twilio_stop");
      return;
    }
  });

  twilioWs.on("close", (code) => {
    log(ctx, `Twilio WS closed: ${code}`);
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
