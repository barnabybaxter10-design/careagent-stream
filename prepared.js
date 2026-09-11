import { randomBytes, timingSafeEqual } from "node:crypto";
import { WebSocket } from "ws";
import { agencyName, liveSessionStart } from "./live.js";

export function validPreparationSecret(value, secret) {
  if (typeof value !== "string" || !secret) return false;
  const received = Buffer.from(value), expected = Buffer.from(secret);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

export function preparationMetadata(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !/^CA[0-9a-f]{32}$/i.test(value.callSid || "") ||
      typeof value.agency_id !== "string" || !value.agency_id.trim() || value.agency_id.length > 128 ||
      !/^\+[1-9]\d{6,14}$/.test(value.to || "") ||
      (value.from !== undefined && (typeof value.from !== "string" || value.from.length > 64))) return null;
  return { callSid: value.callSid, agency_id: value.agency_id, from: value.from || "", to: value.to,
    agency_name: agencyName(value.agency_name) };
}

const matches = (a, b) => ["callSid", "agency_id", "from", "to", "agency_name"].every(key => a[key] === b[key]);
const preparationError = status => Object.assign(new Error("Voice preparation unavailable"), { status });

// One prepared session per authenticated incoming call; no always-on paid pool.
export function createPreparedCalls({ config, connectOpenAI, setupMs = 4000, ttlMs = 20000, limit = 16, closeMs = 1500 }) {
  const records = new Map(), used = new Set(), claimedCalls = new Set(), closing = new Set();

  function closeUnused(ws) {
    if (ws.readyState === WebSocket.CLOSED) return;
    const onError = () => {};
    let timer;
    function clean() { clearTimeout(timer); closing.delete(ws); ws.off("message", onMessage); ws.off("close", clean); ws.off("error", onError); }
    function onMessage(raw) {
      try { if (JSON.parse(raw.toString()).type === "session.closed") ws.close(1000); } catch { /* bounded close below */ }
    }
    closing.add(ws);
    ws.on("error", onError); ws.on("close", clean); ws.on("message", onMessage);
    timer = setTimeout(() => { ws.terminate(); clean(); }, closeMs); timer.unref();
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "session.close" }));
    else ws.terminate();
  }

  async function prepare(meta) {
    if (claimedCalls.has(meta.callSid)) throw preparationError(409);
    const existing = records.get(meta.callSid);
    if (existing) {
      if (!matches(existing.meta, meta)) throw preparationError(409);
      return existing.promise;
    }
    if (records.size >= limit) throw preparationError(429);
    const record = { meta, token: randomBytes(24).toString("base64url"), events: [], bytes: 0, ready: false, startedAt: Date.now() };
    let resolve, reject;
    record.promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    records.set(meta.callSid, record);
    function removeListeners() {
      clearTimeout(record.setupTimer); clearTimeout(record.expiryTimer);
      record.ws?.off("open", onOpen); record.ws?.off("message", onMessage);
      record.ws?.off("close", onClose); record.ws?.off("error", onError);
    }
    function dispose() {
      if (records.get(meta.callSid) !== record) return;
      records.delete(meta.callSid); removeListeners();
      reject(preparationError(503));
      if (record.ws) closeUnused(record.ws);
    }
    function onOpen() { record.ws.send(JSON.stringify(liveSessionStart(config, meta))); }
    function onClose() { dispose(); }
    function onError() { dispose(); }
    function onMessage(raw) {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { dispose(); return; }
      if (msg.type === "error" || msg.type === "session.closed") { dispose(); return; }
      record.bytes += raw.length;
      if (record.bytes > 256 * 1024 || record.events.length >= 128) { dispose(); return; }
      record.events.push(Buffer.from(raw));
      if (msg.type === "session.started" && !record.ready) {
        record.ready = true; record.setupTimeMs = Date.now() - record.startedAt;
        clearTimeout(record.setupTimer);
        record.expiryTimer = setTimeout(dispose, ttlMs); record.expiryTimer.unref();
        resolve({ preparation_token: record.token });
      }
    }
    record.dispose = dispose;
    record.detach = removeListeners;
    record.setupTimer = setTimeout(dispose, setupMs); record.setupTimer.unref();
    try {
      record.ws = connectOpenAI();
      record.ws.on("open", onOpen); record.ws.on("message", onMessage);
      record.ws.on("close", onClose); record.ws.on("error", onError);
    } catch { dispose(); }
    return record.promise;
  }

  function claim(token, meta) {
    if (used.has(token)) return { status: "invalid" };
    const record = records.get(meta.callSid);
    if (!record) return { status: "unavailable" };
    if (record.token !== token || !matches(record.meta, meta)) return { status: "invalid" };
    if (!record.ready || record.ws.readyState !== WebSocket.OPEN) { record.dispose(); return { status: "unavailable" }; }
    records.delete(meta.callSid); record.detach();
    used.add(token);
    claimedCalls.add(meta.callSid);
    if (used.size > 1024) used.delete(used.values().next().value);
    if (claimedCalls.size > 1024) claimedCalls.delete(claimedCalls.values().next().value);
    return { status: "claimed", ws: record.ws, events: record.events, setupTimeMs: record.setupTimeMs };
  }

  function close() {
    for (const record of [...records.values()]) record.dispose();
    for (const ws of closing) ws.terminate();
  }
  return { prepare, claim, close };
}
