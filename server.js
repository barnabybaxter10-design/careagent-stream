import Fastify from "fastify";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import dotenv from "dotenv";

import { RealtimeAgent, RealtimeSession } from "@openai/agents/realtime";
import { TwilioRealtimeTransportLayer } from "@openai/agents-extensions";

dotenv.config();

const PORT = Number(process.env.PORT || 8080);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY");
  process.exit(1);
}

const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";

const VOICE = process.env.OPENAI_VOICE || "ballad";

// Prompt can be big — store it in an env var so you can update without code deploys
const SYSTEM_PROMPT =
  process.env.CAREAGENT_SYSTEM_PROMPT ||
  `You are CareGenie, an automated out-of-hours call assistant for a UK live-in care agency.
Collect key details and escalate when needed. Do NOT give medical advice.`;

const fastify = Fastify({ logger: true });

fastify.register(fastifyFormBody);
fastify.register(fastifyWs);

// Simple health check for Railway
fastify.get("/health", async () => ({ ok: true }));

/**
 * Twilio Media Streams will connect to:
 *   wss://<railway-domain>/stream
 */
fastify.register(async function (app) {
  app.get("/stream", { websocket: true }, async (connection, req) => {
    // Optional: allow agency_id from querystring (multi-tenant routing later)
    // e.g. wss://.../stream?agency_id=abc123
    const url = new URL(req.url, `http://${req.headers.host}`);
    const agencyId = url.searchParams.get("agency_id") || "unknown";

    const agent = new RealtimeAgent({
      name: "CareGenie",
      instructions: SYSTEM_PROMPT,
    });

    try {
      const transport = new TwilioRealtimeTransportLayer({
        twilioWebSocket: connection,
      });

      const session = new RealtimeSession(agent, {
        transport,
        // These map to Realtime session settings
        model: OPENAI_REALTIME_MODEL,
      });

      // Connect to OpenAI Realtime
      await session.connect({ apiKey: OPENAI_API_KEY });

      // Configure voice (and any other session settings)
      // (SDK handles the underlying realtime messages)
      session.updateSession({
        voice: VOICE,
      });

      fastify.log.info(
        { agencyId, model: OPENAI_REALTIME_MODEL },
        "Connected Twilio stream to OpenAI Realtime"
      );

      // When Twilio hangs up, websocket closes, session ends automatically.
    } catch (err) {
      fastify.log.error({ err }, "Realtime connection error");
      try {
        connection.close();
      } catch {}
    }
  });
});

fastify.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  console.log(`Server listening on ${PORT}`);
});
