'use strict';

const ROOM_TTL_SECONDS = 6 * 60 * 60;
const KEY_PREFIX = 'kahoot';

// Room state lives outside the process so any serverless instance can serve any socket.
function createRedisStore(redis) {
  const roomKey = (pin) => `${KEY_PREFIX}:room:${pin}`;
  const playersKey = (pin) => `${KEY_PREFIX}:room:${pin}:players`;
  const claimKey = (name) => `${KEY_PREFIX}:claim:${name}`;

  return {
    async createRoom(pin, meta) {
      const created = await redis.set(roomKey(pin), JSON.stringify(meta), 'EX', ROOM_TTL_SECONDS, 'NX');
      return created === 'OK';
    },
    async saveRoom(pin, meta) {
      await redis.set(roomKey(pin), JSON.stringify(meta), 'EX', ROOM_TTL_SECONDS);
    },
    async getRoom(pin) {
      const raw = await redis.get(roomKey(pin));
      return raw ? JSON.parse(raw) : null;
    },
    async deleteRoom(pin) {
      await redis.del(roomKey(pin), playersKey(pin));
    },
    async getPlayers(pin) {
      const rawPlayers = await redis.hgetall(playersKey(pin));
      return Object.fromEntries(Object.entries(rawPlayers).map(([id, raw]) => [id, JSON.parse(raw)]));
    },
    async getPlayer(pin, playerId) {
      const raw = await redis.hget(playersKey(pin), playerId);
      return raw ? JSON.parse(raw) : null;
    },
    async savePlayer(pin, playerId, player) {
      await redis.hset(playersKey(pin), playerId, JSON.stringify(player));
      await redis.expire(playersKey(pin), ROOM_TTL_SECONDS);
    },
    async removePlayer(pin, playerId) {
      await redis.hdel(playersKey(pin), playerId);
    },
    async claimOnce(name) {
      const claimed = await redis.set(claimKey(name), '1', 'EX', ROOM_TTL_SECONDS, 'NX');
      return claimed === 'OK';
    },
  };
}

// Single-process fallback for local development and tests.
function createMemoryStore() {
  const rooms = new Map();
  const playersByPin = new Map();
  const claims = new Set();

  return {
    async createRoom(pin, meta) {
      if (rooms.has(pin)) return false;
      rooms.set(pin, structuredClone(meta));
      playersByPin.set(pin, new Map());
      return true;
    },
    async saveRoom(pin, meta) {
      rooms.set(pin, structuredClone(meta));
    },
    async getRoom(pin) {
      return rooms.has(pin) ? structuredClone(rooms.get(pin)) : null;
    },
    async deleteRoom(pin) {
      rooms.delete(pin);
      playersByPin.delete(pin);
    },
    async getPlayers(pin) {
      const players = playersByPin.get(pin) || new Map();
      return Object.fromEntries([...players].map(([id, player]) => [id, structuredClone(player)]));
    },
    async getPlayer(pin, playerId) {
      const player = playersByPin.get(pin)?.get(playerId);
      return player ? structuredClone(player) : null;
    },
    async savePlayer(pin, playerId, player) {
      if (!playersByPin.has(pin)) playersByPin.set(pin, new Map());
      playersByPin.get(pin).set(playerId, structuredClone(player));
    },
    async removePlayer(pin, playerId) {
      playersByPin.get(pin)?.delete(playerId);
    },
    async claimOnce(name) {
      if (claims.has(name)) return false;
      claims.add(name);
      return true;
    },
  };
}

function resolveRedisUrl() {
  return process.env.REDIS_URL || process.env.KV_URL || null;
}

function createStore() {
  const redisUrl = resolveRedisUrl();
  if (!redisUrl) {
    console.warn('[store] No REDIS_URL/KV_URL set: using in-memory state (single instance only).');
    return { store: createMemoryStore(), publisher: null, subscriber: null };
  }

  const Redis = require('ioredis');
  const publisher = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
  const subscriber = publisher.duplicate();
  for (const client of [publisher, subscriber]) {
    client.on('error', (error) => console.error('[redis]', error.message));
  }
  return { store: createRedisStore(publisher), publisher, subscriber };
}

module.exports = { createStore, createMemoryStore };
