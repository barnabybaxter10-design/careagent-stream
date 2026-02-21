import http from "http";
import { WebSocketServer } from "ws";

const PORT = process.env.PORT || 8080;

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

wss.on("connection", (ws) => {
  let streamSid = null;
  let mediaCount = 0;

  const interval = setInterval(() => {
    if (ws.readyState === ws.OPEN) ws.ping();
  }, 25000);

  ws.on("message", (raw) => {
    const s = raw.toString();

    let msg;
    try {
      msg = JSON.parse(s);
    } catch (e) {
      console.log("PARSE ERROR:", e.message);
      console.log("RAW:", s);
      return;
    }

    console.log("EVENT:", msg.event);

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("[start]", streamSid);
      return;
    }

    if (msg.event === "media") {
      mediaCount++;
      if (mediaCount % 50 === 0) {
        console.log("MEDIA FRAMES:", streamSid, mediaCount);
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("[stop]", streamSid);
      ws.close();
      return;
    }
  });

  ws.on("close", (code, reason) => {
    clearInterval(interval);
    console.log("CLOSED:", streamSid, code, reason?.toString?.() || "");
  });

  ws.on("error", (err) => {
    clearInterval(interval);
    console.log("WS ERROR:", streamSid, err.message);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
