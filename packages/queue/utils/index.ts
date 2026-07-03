import { logConnection } from "../setup";
import type IORedis from "ioredis";

/* =========================================================
 * Helpers
 * ======================================================= */
export function attachConnectionListeners(conn: IORedis, name = 'Queue') {
    const log = logConnection(name);
    conn.on("connecting", log.connecting);
    conn.on("connect", log.connect);
    conn.on("error", log.error);
    conn.on("close", log.close);
    conn.on("reconnecting", log.reconnecting);
}