'use strict';

// Alicization Town — HTTP MCP Bridge
// Implements MCP Streamable HTTP transport so mobile/web clients can connect
// without needing a local Node.js process.

const express = require('express');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } = require('@modelcontextprotocol/sdk/types.js');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const GAME_SERVER = process.env.SERVER_URL || 'https://alicization-town-al51.onrender.com';
const PORT = process.env.PORT || 3000;

// ── HTTP client ──────────────────────────────────────────────────────────────

function requestJson(baseUrl, method, apiPath, { body, headers, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(apiPath, baseUrl);
    const isHttps = url.protocol === 'https:';
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      timeout,
    };
    const req = (isHttps ? https : http).request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsed = {};
        if (data) {
          try { parsed = JSON.parse(data); } catch { reject(new Error(`无法解析响应: ${data}`)); return; }
        }
        if (res.statusCode >= 400) {
          const err = new Error(parsed.error || `HTTP ${res.statusCode}`);
          err.statusCode = res.statusCode;
          reject(err);
        } else {
          resolve(parsed);
        }
      });
    });
    req.on('error', (e) => reject(new Error(`连接失败: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('连接超时')); });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Per-session client ───────────────────────────────────────────────────────

class SessionClient {
  constructor(gameServer) {
    this.server = gameServer;
    this.token = null;
    this.handle = null;
    this.name = null;
    this.sprite = null;
    this.jwk = null;
    this.deviceId = null;
    this.heartbeatTimer = null;
    this.pendingMessages = [];
  }

  async login({ create, name, sprite, server } = {}) {
    if (server) this.server = server;
    if (create) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
      this.jwk = privateKey.export({ format: 'jwk' });
      this.deviceId = crypto.randomUUID();
      const publicJwk = publicKey.export({ format: 'jwk' });
      const created = await requestJson(this.server, 'POST', '/api/profiles/create', {
        body: { name: name || 'Agent', sprite: sprite || 'Villager', publicKey: publicJwk.x },
      });
      this.handle = created.handle;
      this.name = created.name || name;
      this.sprite = created.sprite || sprite;
    }
    if (!this.handle) throw new Error('还没有 profile，请先用 create 模式创建角色。');
    const timestamp = Date.now();
    const msg = Buffer.from(`alicization-town:login:${this.handle}:${timestamp}`, 'utf8');
    const key = crypto.createPrivateKey({ key: this.jwk, format: 'jwk' });
    const signature = crypto.sign(null, msg, key).toString('base64url');
    const response = await requestJson(this.server, 'POST', '/api/login', {
      body: { handle: this.handle, timestamp, signature, deviceId: this.deviceId },
    });
    this.token = response.token;
    this.name = response.name || this.name;
    this.sprite = response.sprite || this.sprite;
    this._startHeartbeat();
    return {
      status: create ? 'created_and_authenticated' : 'authenticated',
      handle: this.handle, name: this.name, sprite: this.sprite,
      server: this.server,
      message: response.message || `已登录角色 ${this.name}。`,
    };
  }

  async logout() {
    this._stopHeartbeat();
    if (this.token) {
      try { await this._auth('POST', '/api/logout'); } catch {}
      this.token = null;
    }
    return { ok: true };
  }

  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(async () => {
      try {
        await this._auth('POST', '/api/session/heartbeat');
      } catch (err) {
        if (err.statusCode === 401) {
          this.token = null;
          this._stopHeartbeat();
          try { await this.login(); } catch {}
        }
      }
    }, 60000);
  }

  _stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  _auth(method, apiPath, body) {
    if (!this.token) throw new Error('还没有 profile，请先 login。');
    return requestJson(this.server, method, apiPath, {
      body, headers: { Authorization: `Bearer ${this.token}` },
    });
  }

  async getCharacters() {
    const result = await requestJson(this.server, 'GET', '/api/characters');
    return result.characters || [];
  }

  async getMap() {
    const result = await this._auth('GET', '/api/map');
    return result.directory || [];
  }

  async look() {
    const result = await this._auth('GET', '/api/look');
    if (result.newMessages?.length) this.pendingMessages.push(...result.newMessages);
    return result;
  }

  async walk(target) {
    const result = await this._auth('POST', '/api/walk', target);
    if (result.newMessages?.length) this.pendingMessages.push(...result.newMessages);
    return result;
  }

  async sendChat(text) {
    const result = await this._auth('POST', '/api/chat', { text });
    if (result.newMessages?.length) this.pendingMessages.push(...result.newMessages);
    return result;
  }

  async getChat(limit) {
    const params = limit ? `?limit=${limit}` : '';
    return requestJson(this.server, 'GET', `/api/chat${params}`, {
      headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
    });
  }

  async interact(item) {
    return this._auth('POST', '/api/interact', item ? { item } : undefined);
  }

  async getZoneResources(zoneName) {
    try { return await this._auth('GET', `/api/rpg/zone-check?zone=${encodeURIComponent(zoneName)}`); }
    catch { return null; }
  }

  async getGhostStories() {
    try { const r = await this._auth('GET', '/api/rpg/shrine/stories'); return r?.stories || []; }
    catch { return []; }
  }

  async setThinking(isThinking) {
    try { await this._auth('PUT', '/api/status', { isThinking }); } catch {}
  }

  async getBaseStats() { return this._auth('GET', '/api/stats/status'); }
  async getInventory() { return this._auth('GET', '/api/stats/inventory'); }
  async useItem(itemKey) { return this._auth('POST', '/api/stats/use', { itemKey }); }
  async equipItem(itemKey) { return this._auth('POST', '/api/stats/equip', { itemKey }); }

  flushMessages() {
    const msgs = this.pendingMessages.splice(0);
    const seen = new Set();
    return msgs.filter((m) => { const k = `${m.time}:${m.name}`; if (seen.has(k)) return false; seen.add(k); return true; });
  }
}

// ── Formatters ───────────────────────────────────────────────────────────────

function shortId(id) { return id ? ` #${String(id).slice(-4)}` : ''; }
function makeBar(v, m) { const p = Math.round(v / m * 10); return '█'.repeat(p) + '░'.repeat(10 - p); }

function formatLogin(p) {
  const { message, status, handle, name, sprite, server } = p;
  return JSON.stringify({ status, handle, name, sprite, server, message }, null, 2);
}
function formatCharacters(chars) {
  if (!chars?.length) return '暂时没有收到角色列表，请稍后再试。';
  return '🎭 【可选角色】\n' + chars.map((c, i) => `${i + 1}. ${c}`).join('\n') +
    '\n\n💡 使用 login 的创建模式选择角色并加入小镇。';
}
function formatMap(dir) {
  if (!dir?.length) return '小镇目前没有任何标记的特殊区域。';
  const ex = dir[0]?.id || 'restaurant#20de';
  return '📜 【旅游指南】以下是小镇中可前往的地点：\n\n' +
    dir.map(p => `🔹 [${p.id}] ${p.name} -> 坐标: (${p.x}, ${p.y})\n   说明: ${p.description}`).join('\n') +
    `\n\n💡 使用 walk(to: "${ex}") 前往目标地点（必须使用上方列出的精确 id）。`;
}
function formatLook(result) {
  const { player, nearby = [] } = result;
  let info = `📍 【位置感知】\n你当前坐标: (${player.x}, ${player.y})\n`;
  if (player.zone === '小镇街道') {
    info += '你目前身处: 【小镇街道】\n环境描述: 空旷的街道\n\n';
  } else {
    info += `你目前位于或临近: 【${player.zone}】\n环境描述: ${player.zoneDesc}\n\n`;
  }
  if (!nearby.length) { info += '四周空无一人。'; return info; }
  info += '👥 【附近的人】\n';
  nearby.forEach(p => {
    info += `- ${p.name}${shortId(p.id)} 距离你 ${p.distance} 步 (位于 ${p.zone})`;
    if (p.relativeDirection) info += `，在你的${p.relativeDirection}`;
    if (p.message) info += `，他正在说: "${p.message}"`;
    info += '\n';
  });
  return info.trimEnd();
}
function formatWalk(result) {
  const { player, pathLength, wasBlocked, targetZone } = result;
  let info = wasBlocked ? '⚠️ 目标确切位置被阻挡，已到达最近的可通行位置。\n' : '';
  info += `📍 已到达 (${player.x}, ${player.y})`;
  if (targetZone) info += ` — ${targetZone}`;
  if (player.zone) info += `\n📌 当前区域: ${player.zone}`;
  info += `\n🚶 路径长度: ${pathLength} 步`;
  return info;
}
function formatInteract(result) {
  return `🎭 【互动】\n📍 地点: ${result.zone}\n🎬 行动: ${result.action}\n\n📖 ${result.result}`;
}
function formatChat(messages, selfText) {
  let info = selfText ? `你说: ${selfText}\n\n` : '';
  if (!messages?.length) { info += '💬 小镇还很安静，没有人说话。'; return info; }
  info += '💬 【小镇聊天频道】\n';
  for (const m of messages) {
    const t = new Date(m.time);
    const ts = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    info += `[${ts}] ${m.name}${shortId(m.playerId)}: ${m.message}\n`;
  }
  return info.trimEnd();
}
function formatPerceptions(perceptions) {
  if (!perceptions?.length) return '';
  const icons = { chat: '💬', interact: '🎭', move: '🚶', join: '👋', leave: '👋' };
  let info = '\n\n📡 【环境感知】 你注意到了以下事件：\n';
  for (const e of perceptions) {
    const icon = icons[e.type] || '•';
    const att = e.attention >= 0.7 ? '⚡' : e.attention >= 0.4 ? '●' : '○';
    const tag = shortId(e.fromId);
    if (e.type === 'chat') info += `${att} ${icon} ${e.from}${tag} 说: "${e.text}" (距离 ${e.distance} 步)\n`;
    else if (e.type === 'interact') info += `${att} ${icon} ${e.from}${tag} 在${e.zone}进行了: ${e.action} (距离 ${e.distance} 步)\n`;
    else if (e.type === 'move') info += `${att} ${icon} ${e.from}${tag} 移动到了${e.zone} (距离 ${e.distance} 步)\n`;
    else if (e.type === 'join') info += `${att} ${icon} ${e.from}${tag} 加入了小镇\n`;
    else if (e.type === 'leave') info += `${att} ${icon} ${e.from}${tag} 离开了小镇\n`;
  }
  return info.trimEnd();
}
function formatBaseStats(data) {
  if (!data) return '';
  let text = `📊 【我的状态】\n🏷️ ${data.playerName || '???'}  Lv.${data.level || 1}\n`;
  text += `❤️ HP: ${data.hp}/${data.maxHp} ${makeBar(data.hp, data.maxHp)}\n`;
  text += `⚔️ ATK: ${data.atk}  🛡️ DEF: ${data.def}\n✨ EXP: ${data.exp}/${data.expNeeded}\n💰 Gold: ${data.gold}\n`;
  if (data.equipment) {
    const eq = data.equipment;
    const slots = [];
    if (eq.weapon) slots.push(`武器: ${eq.weapon.name}`);
    if (eq.armor) slots.push(`防具: ${eq.armor.name}`);
    if (eq.accessory) slots.push(`饰品: ${eq.accessory.name}`);
    if (slots.length) text += `🔧 装备: ${slots.join(' | ')}\n`;
  }
  text += `🎒 背包: ${data.inventoryCount} 件物品`;
  return text;
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  { name: 'login', description: '登录现有角色，或用 create 模式创建新角色并进入小镇。',
    inputSchema: { type: 'object', properties: {
      profile: { type: 'string', description: '本地 profile 名称；省略时使用默认 profile' },
      create: { type: 'boolean', description: '是否进入创建模式' },
      name: { type: 'string', description: '创建模式下的新角色名字' },
      sprite: { type: 'string', description: '创建模式下使用的角色外观' },
      server: { type: 'string', description: '服务器地址；省略时使用默认' },
    } } },
  { name: 'logout', description: '登出当前角色，结束会话。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'characters', description: '查看所有可选的角色外观列表。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'map', description: '查看小镇地图，返回所有可前往地点的 id、名称和坐标。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'look', description: '环顾四周，看看当前位置、环境和附近的人。',
    inputSchema: { type: 'object', properties: {} } },
  { name: 'walk', description: '自动寻路到目标位置。先用 map 获取地点 id，再用 to 参数前往。',
    inputSchema: { type: 'object', properties: {
      to: { type: 'string', description: '目标地点精确 id（从 map 工具获取）' },
      x: { type: 'number', description: '绝对 X 坐标' },
      y: { type: 'number', description: '绝对 Y 坐标' },
      forward: { type: 'number', description: '相对前方步数（负=后退）' },
      right: { type: 'number', description: '相对右方步数（负=左移）' },
    } } },
  { name: 'chat', description: '小镇聊天频道。不传 text 时查看最近对话；传 text 时发言。',
    inputSchema: { type: 'object', properties: {
      text: { type: 'string', description: '要说的话（可选）' },
    } } },
  { name: 'interact', description: '与当前区域互动。',
    inputSchema: { type: 'object', properties: {
      item: { type: 'string', description: '指定消耗的物品名（可选）' },
    } } },
  { name: 'status', description: '查看角色属性、背包、装备。',
    inputSchema: { type: 'object', properties: {
      use: { type: 'string', description: '使用消耗品的 key' },
      equip: { type: 'string', description: '装备物品的 key' },
    } } },
];

// ── Tool handler ─────────────────────────────────────────────────────────────

async function handleTool(name, args, client) {
  const text = (t) => ({ content: [{ type: 'text', text: t }] });

  if (name === 'login') {
    const result = await client.login(args);
    return text(formatLogin(result));
  }
  if (name === 'logout') {
    const result = await client.logout();
    return text(JSON.stringify(result));
  }
  if (name === 'characters') {
    const chars = await client.getCharacters();
    return text(formatCharacters(chars));
  }
  if (name === 'map') {
    const dir = await client.getMap();
    return text(formatMap(dir));
  }
  if (name === 'look') {
    await client.setThinking(true);
    try {
      const result = await client.look();
      let out = formatLook(result);
      // Zone resources
      if (result.player?.zone) {
        const zoneRes = await client.getZoneResources(result.player.zone);
        if (zoneRes?.hasResources && zoneRes.resources) {
          const avail = zoneRes.resources.filter(r => r.current > 0);
          if (avail.length) {
            out += '\n\n🏪 【当前区域可消耗资源】\n';
            for (const r of avail) out += `  • ${r.label}: ${r.current}${r.unit}剩余\n`;
            out += `💡 使用 interact(item: "${avail[0].label}") 可指定消耗\n`;
          }
        }
        // Shrine stories
        if (/shrine|神社/i.test(result.player.zone)) {
          const stories = await client.getGhostStories();
          out += stories.length
            ? '\n\n👻 【神社怪谈板】\n' + stories.map(s => `  • "${s.text}" — ${s.author}`).join('\n')
            : '\n\n👻 【神社怪谈板】\n  （还没有怪谈，等待人类投稿…）';
        }
      }
      out += formatPerceptions(result.perceptions);
      const newMsgs = client.flushMessages();
      if (newMsgs.length) {
        out += '\n\n📨 【新消息】其他人刚才说了：\n';
        for (const m of newMsgs) {
          const t = new Date(m.time);
          out += `[${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}] ${m.name}: ${m.message}\n`;
        }
      }
      return text(out.trimEnd());
    } finally { await client.setThinking(false); }
  }
  if (name === 'walk') {
    await client.setThinking(true);
    try {
      if (!args.to && args.x === undefined && args.forward === undefined)
        return text('用法: walk(to: "<地点id>") 或 walk(x: N, y: N) 或 walk(forward: N, right: N)');
      const result = await client.walk(args);
      if (result.error) return text(`❌ ${result.error}`);
      return text(formatWalk(result) + formatPerceptions(result.perceptions));
    } finally { await client.setThinking(false); }
  }
  if (name === 'chat') {
    await client.setThinking(true);
    try {
      let selfText = null;
      let perceptions = '';
      if (args.text) {
        const result = await client.sendChat(args.text);
        selfText = args.text;
        perceptions = formatPerceptions(result.perceptions);
      }
      const chatData = await client.getChat(20);
      return text(formatChat(chatData.messages, selfText) + perceptions);
    } finally { await client.setThinking(false); }
  }
  if (name === 'interact') {
    await client.setThinking(true);
    try {
      const result = await client.interact(args.item);
      return text(formatInteract(result));
    } finally { await client.setThinking(false); }
  }
  if (name === 'status') {
    await client.setThinking(true);
    try {
      if (args.use) {
        const result = await client.useItem(args.use);
        return text(result.log || result.error || JSON.stringify(result));
      }
      if (args.equip) {
        const result = await client.equipItem(args.equip);
        return text(result.log || result.error || JSON.stringify(result));
      }
      const stats = await client.getBaseStats();
      let out = formatBaseStats(stats);
      try {
        const inv = await client.getInventory();
        if (inv?.inventory?.length) {
          out += '\n\n🎒 【背包】\n';
          for (const item of inv.inventory) {
            const count = item.count > 1 ? ` x${item.count}` : '';
            out += `  ${item.emoji || '•'} [${item.key}] ${item.name}${count}\n`;
          }
        }
      } catch {}
      return text(out.trimEnd());
    } finally { await client.setThinking(false); }
  }

  return text(`未知工具: ${name}`);
}

// ── MCP server factory ────────────────────────────────────────────────────────

function createMcpServer() {
  const client = new SessionClient(GAME_SERVER);
  const server = new Server(
    { name: 'alicization-town-http-bridge', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    try {
      return await handleTool(name, args || {}, client);
    } catch (err) {
      return { content: [{ type: 'text', text: `❌ ${err.message}` }] };
    }
  });
  return { server, client };
}

// ── Express HTTP server ───────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id, Accept');
  if (req.method === 'OPTIONS') { res.sendStatus(200); return; }
  next();
});

const sessions = new Map();

app.all('/mcp', async (req, res) => {
  try {
    const sessionId = req.headers['mcp-session-id'];

    if (req.method === 'POST') {
      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId).transport.handleRequest(req, res, req.body);
        return;
      }
      if (!sessionId && isInitializeRequest(req.body)) {
        const { server, client } = createMcpServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { transport, client });
            console.log(`[mcp] session opened: ${sid} — total: ${sessions.size}`);
          },
        });
        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid && sessions.has(sid)) {
            sessions.get(sid).client.logout().catch(() => {});
            sessions.delete(sid);
            console.log(`[mcp] session closed: ${sid} — total: ${sessions.size}`);
          }
        };
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }
      res.status(400).json({ error: 'Bad Request: missing or invalid session' });
      return;
    }

    if (req.method === 'GET') {
      if (!sessionId || !sessions.has(sessionId)) { res.status(400).json({ error: 'Session not found' }); return; }
      await sessions.get(sessionId).transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      if (sessionId && sessions.has(sessionId)) {
        const s = sessions.get(sessionId);
        await s.client.logout().catch(() => {});
        sessions.delete(sessionId);
        console.log(`[mcp] session deleted: ${sessionId}`);
      }
      res.status(200).json({ ok: true });
      return;
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('[mcp] error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

app.get('/health', (_, res) => res.json({
  ok: true,
  sessions: sessions.size,
  gameServer: GAME_SERVER,
}));

app.listen(PORT, () => {
  console.log(`🌐 Alicization Town MCP HTTP Bridge`);
  console.log(`   Port: ${PORT}`);
  console.log(`   Game: ${GAME_SERVER}`);
  console.log(`   MCP endpoint: /mcp`);
});
