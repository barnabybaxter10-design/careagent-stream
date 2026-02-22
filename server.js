import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;

// ===== Env =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
const CAREGENIE_SYSTEM_PROMPT = process.env.CAREGENIE_SYSTEM_PROMPT || "";
const CAREGENIE_VOICE = process.env.CAREGENIE_VOICE || "ballad";

// ===== HTTP (health) =====
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(404);
  res.end();
});

// ===== Twilio WS server =====
const wss = new WebSocketServer({ server, path: "/stream" });

function now() {
  return new Date().toISOString();
}

function safeJsonParse(buf) {
  try {
    return JSON.parse(buf.toString());
  } catch {
    return null;
  }
}

function openOpenAIRealtime() {
  // Realtime WS endpoint (per OpenAI docs)
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
    OPENAI_REALTIME_MODEL
  )}`;

  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  return ws;
}

function sendJson(ws, obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

wss.on("connection", (twilioWs) => {
  const connId = Math.random().toString(16).slice(2);

  let streamSid = null;
  let callSid = null;

  let openaiWs = null;
  let openaiReady = false;
  let pendingAudio = [];

  // Keepalive for Twilio socket
  const twilioPing = setInterval(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.ping();
  }, 25000);

  const cleanup = (why) => {
    try {
      clearInterval(twilioPing);
    } catch {}
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
    try {
      if (twilioWs && twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
    } catch {}

    console.log(`${now()} [${connId}] cleanup: ${why} (streamSid=${streamSid})`);
  };

  if (!OPENAI_API_KEY) {
    console.error(`${now()} [${connId}] Missing OPENAI_API_KEY env var`);
    // Let Twilio connect, but it will be silence. Better to close fast.
    // If you prefer to keep call open, remove this line.
    cleanup("missing_openai_api_key");
    return;
  }

  // --- OpenAI WS ---
  openaiWs = openOpenAIRealtime();

  openaiWs.on("open", () => {
    // Configure session for Twilio μ-law in/out
    // - input_audio_format / output_audio_format: g711_ulaw
    // - voice: your chosen voice
    // - instructions: your system prompt
    sendJson(openaiWs, {
      type: "session.update",
      session: {
        voice: CAREGENIE_VOICE,
        instructions: CAREGENIE_SYSTEM_PROMPT,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          create_response: true,
        },
      },
    });

    openaiReady = true;

    // Flush any audio that arrived before OpenAI was ready
    if (pendingAudio.length) {
      for (const payload of pendingAudio) {
        sendJson(openaiWs, { type: "input_audio_buffer.append", audio: payload });
      }
      pendingAudio = [];
    }

    console.log(`${now()} [${connId}] OpenAI WS open`);
  });

  openaiWs.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg) return;

    // OpenAI -> Twilio audio
    // Realtime sends audio chunks as output_audio.delta (base64)
    if (msg.type === "output_audio.delta" && msg.delta && streamSid) {
      const twilioOut = {
        event: "media",
        streamSid,
        media: { payload: msg.delta },
      };
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.send(JSON.stringify(twilioOut));
      }
    }

    // Useful logs (optional)
    if (msg.type === "error") {
      console.error(`${now()} [${connId}] OpenAI error:`, msg.error || msg);
    }
  });

  openaiWs.on("close", (code, reason) => {
    console.log(
      `${now()} [${connId}] OpenAI WS closed: ${code} ${reason?.toString?.() || ""}`
    );
    cleanup("openai_closed");
  });

  openaiWs.on("error", (err) => {
    console.error(`${now()} [${connId}] OpenAI WS error: ${err.message}`);
    cleanup("openai_error");
  });

  // --- Twilio -> OpenAI ---
  twilioWs.on("message", (data) => {
    const msg = safeJsonParse(data);
    if (!msg || !msg.event) return;

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      callSid = msg.start?.callSid || null;
      console.log(`${now()} [${connId}] [start] streamSid=${streamSid} callSid=${callSid}`);
      return;
    }

    if (msg.event === "media") {
      const payload = msg.media?.payload;
      if (!payload) return;

      // Push Twilio audio frames into OpenAI
      if (openaiReady && openaiWs?.readyState === WebSocket.OPEN) {
        sendJson(openaiWs, { type: "input_audio_buffer.append", audio: payload });
      } else {
        // Buffer briefly until OpenAI session.update is sent/open
        pendingAudio.push(payload);
        if (pendingAudio.length > 200) pendingAudio.shift(); // cap memory
      }
      return;
    }

    if (msg.event === "stop") {
      console.log(`${now()} [${connId}] [stop] streamSid=${streamSid}`);
      cleanup("twilio_stop");
      return;
    }
  });

  twilioWs.on("close", (code, reason) => {
    console.log(
      `${now()} [${connId}] Twilio WS closed: ${code} ${reason?.toString?.() || ""}`
    );
    cleanup("twilio_closed");
  });

  twilioWs.on("error", (err) => {
    console.error(`${now()} [${connId}] Twilio WS error: ${err.message}`);
    cleanup("twilio_error");
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
  console.log(`Health: http://0.0.0.0:${PORT}/health`);
  console.log(`WS path: /stream`);
});
