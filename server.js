import http from "http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = process.env.PORT || 8080;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-2025-08-28";
const BASE_PROMPT = process.env.CAREGENIE_SYSTEM_PROMPT || "";

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY env var");
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

function connectOpenAI({ agencyId }) {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(MODEL)}`;

  const oa = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1"
    }
  });

  oa.on("open", () => {
    const instructions = [
      BASE_PROMPT,
      agencyId ? `\n\nAgency context:\n- agency_id: ${agencyId}\n` : ""
    ].join("");

    oa.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions,
          // Twilio Media Streams default audio is 8k mulaw. Keep formats matching.
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          // Voice only matters if you request spoken output; keep default if unsure.
          voice: "ballad",
          turn_detection: { type: "server_vad" }
        }
      })
    );

    // Optional: request the assistant to greet immediately
    oa.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"]
        }
      })
    );
  });

  return oa;
}

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let agencyId = null;
  let openaiWs = null;

  // keepalive so proxies don’t drop idle sockets
  const pingInterval = setInterval(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.ping();
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.ping();
  }, 25000);

  function safeSendTwilio(obj) {
    if (twilioWs.readyState === WebSocket.OPEN) {
      twilioWs.send(JSON.stringify(obj));
    }
  }

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      agencyId = msg.start?.customParameters?.agency_id || null;

      console.log("[twilio start]", streamSid, "agency_id=", agencyId);

      openaiWs = connectOpenAI({ agencyId });

      openaiWs.on("message", (oaRaw) => {
        let oaMsg;
        try {
          oaMsg = JSON.parse(oaRaw.toString());
        } catch {
          return;
        }

        // OpenAI -> Twilio audio
        if (oaMsg.type === "response.audio.delta" && oaMsg.delta) {
          safeSendTwilio({
            event: "media",
            streamSid,
            media: { payload: oaMsg.delta } // already base64
          });
        }

        // Helpful logging
        if (oaMsg.type === "error") {
          console.log("[openai error]", oaMsg);
        }
      });

      openaiWs.on("close", (code, reason) => {
        console.log("[openai closed]", code, reason?.toString?.() || "");
        // If OpenAI closes, Twilio will otherwise sit silent. End the stream cleanly.
        try {
          if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
        } catch {}
      });

      openaiWs.on("error", (err) => {
        console.log("[openai ws error]", err?.message || err);
      });

      return;
    }

    // Twilio -> OpenAI audio
    if (msg.event === "media" && msg.media?.payload && openaiWs?.readyState === WebSocket.OPEN) {
      openaiWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload
        })
      );
      return;
    }

    if (msg.event === "stop") {
      console.log("[twilio stop]", streamSid);
      try {
        if (openaiWs?.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
          openaiWs.close();
        }
      } catch {}
      try {
        twilioWs.close();
      } catch {}
    }
  });

  twilioWs.on("close", () => {
    clearInterval(pingInterval);
    console.log("[twilio ws closed]", streamSid);
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });

  twilioWs.on("error", (err) => {
    clearInterval(pingInterval);
    console.log("[twilio ws error]", err?.message || err);
    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    } catch {}
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
