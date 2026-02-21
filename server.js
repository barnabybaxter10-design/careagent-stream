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

  const interval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    }
  }, 25000);

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid;
      console.log("[start]", streamSid);
    }

    if (msg.event === "stop") {
      console.log("[stop]", streamSid);
      ws.close();
    }
  });

  ws.on("close", () => {
    clearInterval(interval);
    console.log("[ws closed]", streamSid);
  });

  ws.on("error", (err) => {
    clearInterval(interval);
    console.log("[ws error]", err.message);
  });
});

server.listen(PORT, () => {
  console.log(`WebSocket server running on port ${PORT}`);
});
