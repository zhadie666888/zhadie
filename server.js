const { WebSocketServer } = require("ws");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const Database = require("better-sqlite3");
const { CHARACTERS, chatWithAI, MAX_HISTORY } = require("./ai");
const { checkContent, checkUsername } = require("./filter");

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "sdsnt2026admin"; // 部署时改环境变量

// ================= 数据库 =================
const db = new Database("chat.db");
db.pragma("journal_mode = WAL");
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  is_vip INTEGER DEFAULT 0,
  vip_expire INTEGER DEFAULT 0,
  is_banned INTEGER DEFAULT 0,
  banned_until INTEGER DEFAULT 0,
  banned_reason TEXT,
  warn_count INTEGER DEFAULT 0,
  ai_used INTEGER DEFAULT 0,
  ai_date TEXT DEFAULT '',
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL,
  character_id TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS friendships (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_a TEXT NOT NULL,
  user_b TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  UNIQUE(user_a, user_b)
);
CREATE TABLE IF NOT EXISTS dm_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sender TEXT NOT NULL,
  receiver TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter TEXT NOT NULL,
  reported TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

const todayStr = () => new Date().toISOString().slice(0, 10);
const hashPassword = (pwd, salt) => crypto.scryptSync(pwd, salt, 64).toString("hex");
const getUser = (name) => db.prepare("SELECT * FROM users WHERE username = ?").get(name);

// ================= 工具函数 =================
function issueToken(username) {
  const token = crypto.randomBytes(32).toString("hex");
  db.prepare("INSERT INTO tokens (token, username, created_at) VALUES (?, ?, ?)").run(token, username, Date.now());
  return token;
}

function vipValid(user) {
  return user.is_vip === 1 && user.vip_expire > Date.now();
}

// ================= 处罚逻辑 =================
// 第一次警告，第二次封1天，第三次封1周，第四次永久
function punishUser(username, reason) {
  const user = getUser(username);
  if (!user) return null;
  const warn = user.warn_count + 1;
  const now = Date.now();
  const DAY = 86400000;

  if (warn === 1) {
    db.prepare("UPDATE users SET warn_count = ? WHERE username = ?").run(warn, username);
    return { action: "warn", text: `⚠️ 警告（第1次）：您发送了违禁内容（${reason}），再次违规将被封号！` };
  } else if (warn === 2) {
    db.prepare("UPDATE users SET warn_count = ?, is_banned = 1, banned_until = ?, banned_reason = ? WHERE username = ?")
      .run(warn, now + DAY, `发布违禁内容（${reason}）`, username);
    kickUser(username, `您因发布违禁内容被封禁1天`);
    return { action: "ban1d", text: "已封禁1天" };
  } else if (warn === 3) {
    db.prepare("UPDATE users SET warn_count = ?, is_banned = 1, banned_until = ?, banned_reason = ? WHERE username = ?")
      .run(warn, now + 7 * DAY, `发布违禁内容（${reason}）`, username);
    kickUser(username, `您因再次发布违禁内容被封禁7天`);
    return { action: "ban7d", text: "已封禁7天" };
  } else {
    db.prepare("UPDATE users SET warn_count = ?, is_banned = 1, banned_until = 99999999999999, banned_reason = ? WHERE username = ?")
      .run(warn, `多次发布违禁内容，永久封禁`, username);
    kickUser(username, "您因多次发布违禁内容被永久封禁");
    return { action: "ban_forever", text: "已永久封禁" };
  }
}

function isBannedNow(user) {
  if (user.is_banned !== 1) return false;
  if (user.banned_until === 99999999999999) return true; // 永久
  if (user.banned_until > Date.now()) return true;
  // 封禁到期自动解封
  db.prepare("UPDATE users SET is_banned = 0 WHERE username = ?").run(user.username);
  return false;
}

function kickUser(username, reason) {
  for (const [, clients] of sockets) {
    for (const client of clients) {
      if (client.username === username && client.readyState === 1) {
        client.send(JSON.stringify({ type: "kicked", content: reason }));
        client.close();
      }
    }
  }
}

function pushUserState(username) {
  const user = getUser(username);
  if (!user) return;
  for (const [, clients] of sockets) {
    for (const client of clients) {
      if (client.username === username && client.readyState === 1) {
        client.send(JSON.stringify({ type: "state", is_vip: vipValid(user), is_banned: isBannedNow(user) }));
      }
    }
  }
}

// ================= AI对话 =================
function aiLoadFactory(username, characterId) {
  return () => {
    const rows = db.prepare(
      "SELECT role, content FROM ai_messages WHERE username = ? AND character_id = ? ORDER BY id DESC LIMIT ?"
    ).all(username, characterId, MAX_HISTORY).reverse();
    return rows;
  };
}

// ================= HTTP服务器 =================
function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function serveFile(res, path, type) {
  fs.readFile(path, (err, data) => {
    if (err) { res.writeHead(500); res.end("error"); return; }
    res.writeHead(200, { "Content-Type": `${type}; charset=utf-8` });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // ---- 页面 ----
  if (url === "/" ) return serveFile(res, "./web/index.html", "text/html");
  if (url === "/home") return serveFile(res, "./web/home.html", "text/html");
  if (url === "/ai") return serveFile(res, "./web/ai.html", "text/html");
  if (url === "/chat") return serveFile(res, "./web/chat.html", "text/html");
  if (url === "/me") return serveFile(res, "./web/me.html", "text/html");
  if (url === "/admin") return serveFile(res, "./web/admin.html", "text/html");

  // ---- 注册/登录 ----
  if (url === "/api/register" && req.method === "POST") {
    const { username, password } = JSON.parse(await readBody(req));
    const name = String(username || "").trim();
    if (!name || name.length < 2 || name.length > 16) return json(res, 400, { error: "用户名需2~16个字符" });
    if (!/^[a-zA-Z0-9_\u4e00-\u9fa5]+$/.test(name)) return json(res, 400, { error: "用户名只能包含中英文、数字、下划线" });
    if (!password || String(password).length < 6) return json(res, 400, { error: "密码至少6位，需包含大小写字母或数字" });
    if (!/[a-z]/.test(password) || !/[A-Z0-9]/.test(password)) return json(res, 400, { error: "密码需包含小写字母，以及大写字母或数字" });
    const nameCheck = checkUsername(name);
    if (nameCheck.hit) return json(res, 400, { error: "用户名包含违禁词" });
    if (getUser(name)) return json(res, 409, { error: "用户名已被占用" });

    const salt = crypto.randomBytes(16).toString("hex");
    db.prepare("INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)")
      .run(name, hashPassword(password, salt), salt, Date.now());
    return json(res, 200, { ok: true, token: issueToken(name), username: name });
  }

  if (url === "/api/login" && req.method === "POST") {
    const { username, password } = JSON.parse(await readBody(req));
    const user = getUser(String(username || "").trim());
    if (!user || hashPassword(String(password), user.salt) !== user.password_hash)
      return json(res, 401, { error: "用户名或密码错误" });
    if (isBannedNow(user)) {
      const forever = user.banned_until === 99999999999999;
      return json(res, 403, { error: forever ? `账号已永久封禁：${user.banned_reason}` : `账号封禁至 ${new Date(user.banned_until).toLocaleString()}：${user.banned_reason}` });
    }
    db.prepare("UPDATE users SET last_login = ? WHERE id = ?").run(Date.now(), user.id);
    return json(res, 200, { ok: true, token: issueToken(user.username), username: user.username, is_vip: vipValid(user) });
  }

  // ---- VIP价格 / 购买申请 ----
  if (url === "/api/vip/request" && req.method === "POST") {
    const { token, plan } = JSON.parse(await readBody(req));
    const t = db.prepare("SELECT username FROM tokens WHERE token = ?").get(token);
    if (!t) return json(res, 401, { error: "登录失效" });
    const PRICES = { week: 5, month: 10, year: 20 };
    if (!PRICES[plan]) return json(res, 400, { error: "无效套餐" });
    console.log(`[VIP申请] 用户 ${t.username} 申请 ${plan} 套餐（¥${PRICES[plan]}），请管理员在后台处理`);
    return json(res, 200, { ok: true, msg: "已提交VIP申请，请联系管理员开通（付款后生效）" });
  }

  // ---- 管理后台API ----
  if (url.startsWith("/api/admin")) {
    if (req.headers["x-admin-password"] !== ADMIN_PASSWORD) return json(res, 401, { error: "密码错误" });

    if (url === "/api/admin/users" && req.method === "GET") {
      const users = db.prepare("SELECT username, is_vip, vip_expire, is_banned, banned_until, banned_reason, warn_count, ai_used, ai_date, created_at, last_login FROM users ORDER BY created_at DESC").all();
      return json(res, 200, { users: users.map(u => ({ ...u, vip_active: vipValid(u), banned_now: isBannedNow(u) })) });
    }

    if (url === "/api/admin/reports" && req.method === "GET") {
      const reports = db.prepare("SELECT * FROM reports ORDER BY id DESC LIMIT 100").all();
      return json(res, 200, { reports });
    }

    if (url === "/api/admin/action" && req.method === "POST") {
      const { username, action, value } = JSON.parse(await readBody(req));
      const user = getUser(username);
      if (!user) return json(res, 404, { error: "用户不存在" });
      const now = Date.now();
      const DAY = 86400000;
      switch (action) {
        case "ban": // value = 天数或 "forever"
          if (value === "forever") {
            db.prepare("UPDATE users SET is_banned = 1, banned_until = 99999999999999, banned_reason = ? WHERE username = ?").run("管理员封禁", username);
          } else {
            db.prepare("UPDATE users SET is_banned = 1, banned_until = ?, banned_reason = ? WHERE username = ?")
              .run(now + Number(value || 1) * DAY, "管理员封禁", username);
          }
          kickUser(username, "您的账号已被管理员封禁");
          break;
        case "unban":
          db.prepare("UPDATE users SET is_banned = 0, banned_until = 0, banned_reason = NULL, warn_count = 0 WHERE username = ?").run(username);
          break;
        case "vip": // value = "week" | "month" | "year"
          const vipDays = { week: 7, month: 30, year: 365 }[value] || 30;
          const base = vipValid(user) ? user.vip_expire : now;
          db.prepare("UPDATE users SET is_vip = 1, vip_expire = ? WHERE username = ?").run(base + vipDays * DAY, username);
          pushUserState(username);
          break;
        case "vip_off":
          db.prepare("UPDATE users SET is_vip = 0, vip_expire = 0 WHERE username = ?").run(username);
          pushUserState(username);
          break;
        default:
          return json(res, 400, { error: "未知操作" });
      }
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: "not found" });
  }

  res.writeHead(404); res.end();
});

// ================= WebSocket =================
const wss = new WebSocketServer({ server });
const sockets = new Map(); // username -> Set<ws>

function addSocket(username, ws) {
  if (!sockets.has(username)) sockets.set(username, new Set());
  sockets.get(username).add(ws);
}
function sendToUser(username, payload) {
  const set = sockets.get(username);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const c of set) if (c.readyState === 1) c.send(data);
}

wss.on("connection", (ws) => {
  ws.username = null;

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ---- 认证 ----
    if (msg.type === "auth") {
      const t = db.prepare("SELECT username FROM tokens WHERE token = ?").get(msg.token);
      if (!t) return ws.send(JSON.stringify({ type: "auth_fail", content: "登录已失效" }));
      const user = getUser(t.username);
      if (!user || isBannedNow(user)) {
        const forever = user && user.banned_until === 99999999999999;
        return ws.send(JSON.stringify({ type: "kicked", content: forever ? "账号已永久封禁" : "账号封禁中" }));
      }
      ws.username = user.username;
      ws.is_vip = vipValid(user);
      addSocket(user.username, ws);
      ws.send(JSON.stringify({ type: "auth_ok", username: user.username, is_vip: ws.is_vip }));
      return;
    }

    if (!ws.username) return ws.send(JSON.stringify({ type: "auth_fail", content: "请先登录" }));
    const me = getUser(ws.username);
    if (!me || isBannedNow(me)) return;

    // ---- AI聊天 ----
    if (msg.type === "ai_chat") {
      const characterId = String(msg.character_id || "");
      if (!CHARACTERS[characterId]) return;
      const content = String(msg.content || "").slice(0, 500).trim();
      if (!content) return;

      // 违禁词检测：AI聊天也算聊天内容
      const hit = checkContent(content);
      if (hit.hit) {
        const result = punishUser(ws.username, hit.word);
        ws.send(JSON.stringify({ type: "punish", content: result ? result.text : "违禁内容已拦截" }));
        return;
      }

      // VIP检查 + 每日10句限制
      const user = getUser(ws.username);
      const today = todayStr();
      let used = (user.ai_date === today) ? user.ai_used : 0;
      if (!vipValid(user) && used >= 10) {
        return ws.send(JSON.stringify({ type: "ai_limit", content: "今日免费AI对话已达10句上限，开通VIP可无限畅聊哦～" }));
      }
      used++;
      db.prepare("UPDATE users SET ai_used = ?, ai_date = ? WHERE username = ?").run(used, today, ws.username);

      // 存用户消息
      db.prepare("INSERT INTO ai_messages (username, character_id, role, content, created_at) VALUES (?, ?, 'user', ?, ?)")
        .run(ws.username, characterId, content, Date.now());

      ws.send(JSON.stringify({ type: "ai_used", used, limit: vipValid(user) ? "无限" : 10 }));

      // 调AI
      try {
        const load = aiLoadFactory(ws.username, characterId);
        const reply = await chatWithAI(characterId, ws.username, { load });
        db.prepare("INSERT INTO ai_messages (username, character_id, role, content, created_at) VALUES (?, ?, 'assistant', ?, ?)")
          .run(ws.username, characterId, reply, Date.now());
        ws.send(JSON.stringify({
          type: "ai_reply", character_id: characterId,
          content: reply, avatar: CHARACTERS[characterId].avatar,
        }));
      } catch (e) {
        ws.send(JSON.stringify({ type: "system", content: `${CHARACTERS[characterId].name} 暂时没回上，再发一次试试` }));
      }
      return;
    }

    // ---- 好友系统 ----
    if (msg.type === "friend_request") {
      const target = String(msg.target || "").trim();
      const tUser = getUser(target);
      if (!tUser) return ws.send(JSON.stringify({ type: "system", content: "用户不存在" }));
      if (target === ws.username) return ws.send(JSON.stringify({ type: "system", content: "不能添加自己" }));
      const existing = db.prepare("SELECT * FROM friendships WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)")
        .get(ws.username, target, target, ws.username);
      if (existing) {
        if (existing.status === "accepted") return ws.send(JSON.stringify({ type: "system", content: "你们已经是好友了" }));
        // 对方之前给我发过申请 → 直接成为好友
        db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(existing.id);
        sendToUser(existing.user_a, { type: "friend_accepted", who: existing.user_b });
        sendToUser(existing.user_b, { type: "friend_accepted", who: existing.user_a });
        return ws.send(JSON.stringify({ type: "system", content: `已和 ${target} 成为好友` }));
      }
      db.prepare("INSERT INTO friendships (user_a, user_b, status, created_at) VALUES (?, ?, 'pending', ?)")
        .run(ws.username, target, Date.now());
      sendToUser(target, { type: "friend_request", from: ws.username, content: `${ws.username} 请求添加你为好友` });
      ws.send(JSON.stringify({ type: "system", content: `好友申请已发送给 ${target}` }));
      return;
    }

    if (msg.type === "friend_accept") {
      const from = String(msg.from || "");
      const row = db.prepare("SELECT * FROM friendships WHERE user_a = ? AND user_b = ? AND status = 'pending'").get(from, ws.username);
      if (row) {
        db.prepare("UPDATE friendships SET status = 'accepted' WHERE id = ?").run(row.id);
        sendToUser(from, { type: "friend_accepted", who: ws.username });
        ws.send(JSON.stringify({ type: "friend_accepted", who: from, content: `已添加 ${from} 为好友` }));
      }
      return;
    }

    if (msg.type === "friend_delete") {
      const target = String(msg.target || "");
      db.prepare("DELETE FROM friendships WHERE (user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)")
        .run(ws.username, target, target, ws.username);
      ws.send(JSON.stringify({ type: "friend_deleted", who: target, content: `已删除好友 ${target}` }));
      return;
    }

    if (msg.type === "friend_list") {
      const rows = db.prepare("SELECT * FROM friendships WHERE (user_a = ? OR user_b = ?) AND status = 'accepted'").all(ws.username, ws.username);
      const friends = rows.map(r => r.user_a === ws.username ? r.user_b : r.user_a);
      const pending = db.prepare("SELECT user_a FROM friendships WHERE user_b = ? AND status = 'pending'").all(ws.username).map(r => r.user_a);
      ws.send(JSON.stringify({ type: "friend_list", friends, pending }));
      return;
    }

    // ---- 私聊 ----
    if (msg.type === "dm") {
      const to = String(msg.to || "");
      const content = String(msg.content || "").slice(0, 1000).trim();
      if (!content) return;

      // 必须是好友
      const friendship = db.prepare("SELECT id FROM friendships WHERE ((user_a = ? AND user_b = ?) OR (user_a = ? AND user_b = ?)) AND status = 'accepted'")
        .get(ws.username, to, to, ws.username);
      if (!friendship) return ws.send(JSON.stringify({ type: "system", content: "只能给好友发消息" }));

      // 违禁检测
      const hit = checkContent(content);
      if (hit.hit) {
        // 谐音违禁直接封1天；普通违禁走警告递增
        const homophone = String(msg.content) !== content.replace(/\s+/g, "") || /\s|拼音|谐音/.test(msg.original || "");
        const result = punishUser(ws.username, hit.word);
        ws.send(JSON.stringify({ type: "punish", content: result ? result.text : "违禁内容已拦截" }));
        return;
      }

      db.prepare("INSERT INTO dm_messages (sender, receiver, content, created_at) VALUES (?, ?, ?, ?)")
        .run(ws.username, to, content, Date.now());
      sendToUser(to, { type: "dm", from: ws.username, content });
      ws.send(JSON.stringify({ type: "dm_sent", to, content }));
      return;
    }

    // ---- 聊天记录 ----
    if (msg.type === "dm_history") {
      const withUser = String(msg.with || "");
      const rows = db.prepare(
        `SELECT sender, content, created_at FROM dm_messages
         WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
         ORDER BY id DESC LIMIT 100`
      ).all(ws.username, withUser, withUser, ws.username).reverse();
      ws.send(JSON.stringify({ type: "dm_history", with: withUser, messages: rows }));
      return;
    }

    if (msg.type === "clear_history") {
      const withUser = String(msg.with || "");
      db.prepare("DELETE FROM dm_messages WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)")
        .run(ws.username, withUser, withUser, ws.username);
      ws.send(JSON.stringify({ type: "system", content: "聊天记录已清除" }));
      return;
    }

    // ---- 举报 ----
    if (msg.type === "report") {
      const reported = String(msg.reported || "");
      const message = String(msg.message || "").slice(0, 1000);
      db.prepare("INSERT INTO reports (reporter, reported, message, created_at) VALUES (?, ?, ?, ?)")
        .run(ws.username, reported, message, Date.now());

      // 检测被举报消息：违禁或谐音违禁 → 直接封1天
      const hit = checkContent(message);
      if (hit.hit) {
        const targetUser = getUser(reported);
        if (targetUser && !isBannedNow(targetUser)) {
          const DAY = 86400000;
          db.prepare("UPDATE users SET is_banned = 1, banned_until = ?, banned_reason = ? WHERE username = ?")
            .run(Date.now() + DAY, `被举报发布违禁内容（${hit.word}）`, reported);
          kickUser(reported, "您因被举报发布违禁内容被封禁1天");
          ws.send(JSON.stringify({ type: "system", content: `举报成功，对方已被封禁1天` }));
        } else {
          ws.send(JSON.stringify({ type: "system", content: "举报已提交，感谢反馈" }));
        }
      } else {
        ws.send(JSON.stringify({ type: "system", content: "举报已提交，管理员会尽快处理" }));
      }
      return;
    }
  });

  ws.on("close", () => {
    if (ws.username && sockets.has(ws.username)) {
      sockets.get(ws.username).delete(ws);
      if (sockets.get(ws.username).size === 0) sockets.delete(ws.username);
    }
  });
});

server.listen(PORT, () => {
  console.log(`时代少年团AI聊天 服务器启动: http://localhost:${PORT}`);
  console.log(`管理后台: /admin （密码在环境变量 ADMIN_PASSWORD）`);
});