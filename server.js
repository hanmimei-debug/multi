import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import fs from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static(join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const SAVE_DIR = join(__dirname, "saves");
if (!fs.existsSync(SAVE_DIR)) fs.mkdirSync(SAVE_DIR, { recursive: true });

// ---- 房间状态 ----
// rooms[code] = {
//   code, hostId, api:{baseUrl,key,model,temperature},
//   systemPrompt, players:{socketId:{name,character,ready,action,submitted}},
//   history:[{role,content}], round, phase, generating
// }
const rooms = {};

function genCode() {
  let c;
  do {
    c = Math.random().toString(36).slice(2, 8).toUpperCase();
  } while (rooms[c]);
  return c;
}

// 发给客户端的房间视图(隐藏 api key 等敏感字段)
function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    round: room.round,
    phase: room.phase,
    generating: room.generating,
    hasApi: !!(room.api && room.api.key && room.api.baseUrl && room.api.model),
    model: room.api ? room.api.model : "",
    charTemplate: room.charTemplate || "",
    players: Object.entries(room.players).map(([id, p]) => ({
      id,
      name: p.name,
      character: p.character,
      isHost: id === room.hostId,
      submitted: p.submitted,
      action: p.submitted ? p.action : "",
      items: p.items || [],
      status: p.status || [],
      connected: p.connected !== false,
    })),
    reactions: room.reactions || [],
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit("room", publicRoom(room));
}

function saveFile(room) {
  try {
    const path = join(SAVE_DIR, `${room.code}.json`);
    fs.writeFileSync(
      path,
      JSON.stringify(
        {
          systemPrompt: room.systemPrompt,
          history: room.history,
          round: room.round,
        },
        null,
        2
      )
    );
  } catch (e) {
    console.error("存档失败", e.message);
  }
}

// 把用户填的 base_url 规整成 .../chat/completions,尽量宽容各种填法
function buildEndpoint(baseUrl) {
  let u = (baseUrl || "").trim().replace(/\/+$/, "");
  if (!u) return "";
  if (/\/chat\/completions$/.test(u)) return u; // 已经是完整路径
  if (/\/v\d+$/.test(u)) return u + "/chat/completions"; // 以 /v1 结尾
  // 裸域名(如 https://api.deepseek.com):补 /v1/chat/completions
  return u + "/v1/chat/completions";
}

function resetSubmissions(room) {
  for (const p of Object.values(room.players)) {
    p.submitted = false;
    p.action = "";
  }
}

function allSubmitted(room) {
  const ps = Object.values(room.players);
  return ps.length > 0 && ps.every((p) => p.submitted);
}

// 调用 OpenAI 兼容接口,流式把内容推给房间所有人
async function runAI(room) {
  if (room.generating) return;
  const { baseUrl, key, model, temperature } = room.api || {};
  if (!baseUrl || !key || !model) {
    io.to(room.code).emit("errorMsg", "房主还没配置 API(base_url / key / 模型)。");
    return;
  }
  room.generating = true;
  room.phase = "generating";
  broadcastRoom(room);

  const url = buildEndpoint(baseUrl);
  const messages = [
    { role: "system", content: room.systemPrompt || "你是一个文字冒险游戏的主持人。" },
    ...room.history,
  ];

  let full = "";
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof temperature === "number" ? temperature : 0.8,
        stream: true,
      }),
    });

    if (!resp.ok || !resp.body) {
      const txt = await resp.text().catch(() => "");
      throw new Error(`接口返回 ${resp.status} (请求地址 ${url})：${txt.slice(0, 300)}`);
    }

    io.to(room.code).emit("aiStart", { round: room.round });
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const data = t.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta?.content || "";
          if (delta) {
            full += delta;
            io.to(room.code).emit("aiDelta", delta);
          }
        } catch {
          /* 忽略解析不了的行 */
        }
      }
    }
  } catch (e) {
    room.generating = false;
    room.phase = "acting";
    io.to(room.code).emit("errorMsg", "AI 调用失败: " + e.message);
    broadcastRoom(room);
    return;
  }

  room.history.push({ role: "assistant", content: full });
  room.generating = false;
  room.phase = "acting";
  resetSubmissions(room);
  saveFile(room);
  io.to(room.code).emit("aiEnd", { content: full, round: room.round });
  broadcastRoom(room);
  extractItems(room, full); // 后台二次解析物品/状态变化,不阻塞
}

// 二次调用 AI,从剧情里读出各玩家的物品/状态变化,更新背包
async function extractItems(room, story) {
  const { baseUrl, key, model } = room.api || {};
  if (!baseUrl || !key || !model) return;
  const names = Object.values(room.players).map((p) => p.name);
  if (!names.length) return;
  const prompt =
    `下面是一段多人文字游戏的剧情。玩家有:${names.join("、")}。\n` +
    `请判断这段剧情里,每位玩家「获得了什么新物品」「失去了什么物品」「新增了什么身体/情绪/关系状态」。\n` +
    `严格只输出 JSON,不要任何多余文字,格式:\n` +
    `{"changes":[{"name":"玩家名","addItems":["物品"],"removeItems":["物品"],"addStatus":["状态"]}]}\n` +
    `没有任何变化就输出 {"changes":[]}。物品/状态用简短中文名词。\n\n剧情:\n` +
    story.slice(0, 4000);
  try {
    const resp = await fetch(buildEndpoint(baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        stream: false,
      }),
    });
    if (!resp.ok) return;
    const json = await resp.json();
    let txt = json.choices?.[0]?.message?.content?.trim() || "";
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return;
    const parsed = JSON.parse(m[0]);
    for (const ch of parsed.changes || []) {
      const p = Object.values(room.players).find((x) => x.name === ch.name);
      if (!p) continue;
      p.items = p.items || [];
      p.status = p.status || [];
      for (const it of ch.addItems || []) if (it && !p.items.includes(it)) p.items.push(it);
      for (const it of ch.removeItems || []) {
        const i = p.items.indexOf(it);
        if (i !== -1) p.items.splice(i, 1);
      }
      for (const st of ch.addStatus || []) if (st && !p.status.includes(st)) p.status.push(st);
    }
    broadcastRoom(room);
  } catch {
    /* 解析失败就跳过,不影响游戏 */
  }
}

io.on("connection", (socket) => {
  let joinedCode = null;

  socket.on("createRoom", ({ name, clientId }, cb) => {
    const code = genCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      api: { baseUrl: "", key: "", model: "", temperature: 0.8 },
      systemPrompt: "",
      players: {},
      history: [],
      round: 0,
      phase: "lobby",
      generating: false,
      reactions: [],
      transfers: [],
    };
    rooms[code].players[socket.id] = {
      name: name || "房主",
      clientId: clientId || socket.id,
      character: "",
      submitted: false,
      action: "",
      items: [],
      status: [],
      connected: true,
    };
    joinedCode = code;
    socket.join(code);
    cb && cb({ ok: true, code });
    broadcastRoom(rooms[code]);
  });

  socket.on("joinRoom", ({ code, name, clientId }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: "房间不存在" });
    room.players[socket.id] = {
      name: name || "玩家",
      clientId: clientId || socket.id,
      character: "",
      submitted: false,
      action: "",
      items: [],
      status: [],
      connected: true,
    };
    joinedCode = code;
    socket.join(code);
    cb && cb({ ok: true, code });
    io.to(code).emit("sysMsg", `${name || "玩家"} 加入了房间`);
    // 新玩家补发已有剧情
    if (room.history.length) {
      socket.emit("historyDump", room.history, room.round);
    }
    broadcastRoom(room);
  });

  // 断线重连:凭 clientId 认领回原座位
  socket.on("rejoin", ({ code, clientId, name }, cb) => {
    code = (code || "").toUpperCase().trim();
    const room = rooms[code];
    if (!room) return cb && cb({ ok: false, error: "房间已关闭" });
    // 找到 clientId 对应的老玩家
    let oldId = null;
    for (const [id, p] of Object.entries(room.players)) {
      if (p.clientId === clientId) { oldId = id; break; }
    }
    if (oldId) {
      // 把老座位迁移到新 socket.id
      const p = room.players[oldId];
      if (p._graceTimer) { clearTimeout(p._graceTimer); p._graceTimer = null; }
      p.connected = true;
      delete room.players[oldId];
      room.players[socket.id] = p;
      if (room.hostId === oldId) room.hostId = socket.id; // 房主身份也迁移
    } else {
      // 找不到老座位(可能已被清理),当新玩家加入
      room.players[socket.id] = {
        name: name || "玩家",
        clientId: clientId || socket.id,
        character: "", submitted: false, action: "",
        items: [], status: [], connected: true,
      };
    }
    joinedCode = code;
    socket.join(code);
    cb && cb({ ok: true, code });
    if (room.history.length) socket.emit("historyDump", room.history, room.round);
    broadcastRoom(room);
  });

  // 房主配置 API + 系统指令
  socket.on("configRoom", ({ code, api, systemPrompt }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    if (api) {
      room.api = {
        baseUrl: api.baseUrl ?? room.api.baseUrl,
        key: api.key ?? room.api.key,
        model: api.model ?? room.api.model,
        temperature:
          typeof api.temperature === "number" ? api.temperature : room.api.temperature,
      };
    }
    if (typeof systemPrompt === "string") room.systemPrompt = systemPrompt;
    broadcastRoom(room);
  });

  // 房主根据主设定生成"角色填空模板"(一次性调用 AI,不进历史)
  socket.on("genTemplate", async ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id) return;
    const { baseUrl, key, model } = room.api || {};
    if (!baseUrl || !key || !model)
      return socket.emit("errorMsg", "请先填写并保存 API 再生成模板。");
    if (!room.systemPrompt || !room.systemPrompt.trim())
      return socket.emit("errorMsg", "请先填写“模拟器指令(主设定)”再生成模板。");

    socket.emit("tplStatus", "生成中");
    const prompt =
      `下面是一个文字游戏的主设定。请据此为“玩家角色设定”设计一份填空模板,` +
      `让每位玩家照着填就能创建自己的角色。要求:\n` +
      `- 只输出模板本身,每行一个字段,形如「字段名：」后面留空给玩家填;\n` +
      `- 字段要贴合这个主设定的世界观(如姓名、身份、性格、与关键NPC的关系等);\n` +
      `- 6~10 个字段即可,简洁,全中文,不要解释、不要示例内容。\n\n主设定:\n` +
      room.systemPrompt;
    const tplUrl = buildEndpoint(baseUrl);
    try {
      const resp = await fetch(tplUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.5,
          stream: false,
        }),
      });
      if (!resp.ok)
        throw new Error(
          `接口返回 ${resp.status} (请求地址 ${tplUrl})：${(await resp.text()).slice(0, 200)}`
        );
      const json = await resp.json();
      const tpl = json.choices?.[0]?.message?.content?.trim() || "";
      room.charTemplate = tpl;
      io.to(room.code).emit("tplStatus", "完成");
      broadcastRoom(room);
    } catch (e) {
      socket.emit("errorMsg", "模板生成失败: " + e.message);
      socket.emit("tplStatus", "失败");
    }
  });

  // 玩家请求刷新房间状态(手动同步)
  socket.on("refreshRoom", ({ code }) => {
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "房间不存在或已关闭");
    broadcastRoom(room);
  });

  // 玩家更新自己的角色设定
  socket.on("setCharacter", ({ code, character }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    room.players[socket.id].character = character || "";
    broadcastRoom(room);
  });

  // 房主开始游戏:打包所有角色设定当开场
  socket.on("startGame", ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.generating) return;
    const roster = Object.values(room.players)
      .map((p, i) => `玩家${i + 1}「${p.name}」的角色设定:\n${p.character || "(未填写)"}`)
      .join("\n\n");
    const opening =
      `本局共有 ${Object.keys(room.players).length} 位玩家,他们在同一个故事里各自扮演一个角色。\n\n` +
      roster +
      `\n\n请据此生成第一回合:交代背景、各角色如何相遇/登场的前置剧情,` +
      `并在结尾分别向每位玩家给出本回合的行动选项。`;
    room.history = [{ role: "user", content: opening }];
    room.round = 1;
    runAI(room);
  });

  // 玩家提交本回合行动
  socket.on("submitAction", ({ code, action }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id] || room.phase !== "acting") return;
    const p = room.players[socket.id];
    p.action = action || "(本回合无特别行动)";
    p.submitted = true;
    broadcastRoom(room);
    // 全员提交后不立刻推进,留一个"互相回应"窗口,由房主点推进
  });

  // 玩家对某人已提交的行动追加回应
  socket.on("react", ({ code, targetId, text }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id] || room.phase !== "acting") return;
    if (!text || !text.trim()) return;
    const me = room.players[socket.id];
    const target = room.players[targetId];
    room.reactions.push({
      from: me.name,
      to: target ? target.name : "全场",
      text: text.trim(),
    });
    broadcastRoom(room);
  });

  // 玩家把某件物品转交给另一位玩家
  socket.on("giveItem", ({ code, toId, item }) => {
    const room = rooms[code];
    if (!room || !room.players[socket.id]) return;
    const me = room.players[socket.id];
    const to = room.players[toId];
    if (!to || !item) return;
    const idx = (me.items || []).indexOf(item);
    if (idx === -1) return;
    me.items.splice(idx, 1);
    to.items = to.items || [];
    to.items.push(item);
    room.transfers.push({ from: me.name, to: to.name, item });
    broadcastRoom(room);
  });

  // 房主推进回合(等所有人回应完再点)
  socket.on("forceAdvance", ({ code }) => {
    const room = rooms[code];
    if (!room || room.hostId !== socket.id || room.phase !== "acting") return;
    advanceRound(room);
  });

  function advanceRound(room) {
    if (room.generating) return;
    const acts = Object.values(room.players)
      .filter((p) => p.submitted)
      .map((p) => `「${p.name}」(${p.character ? p.character.split("\n")[0] : "玩家"}):${p.action}`)
      .join("\n");
    let msg = `第 ${room.round} 回合各玩家的行动如下:\n${acts}\n`;
    if (room.reactions.length) {
      const rx = room.reactions.map((r) => `「${r.from}」对「${r.to}」的回应:${r.text}`).join("\n");
      msg += `\n玩家之间的相互回应:\n${rx}\n`;
    }
    if (room.transfers.length) {
      const tx = room.transfers.map((t) => `「${t.from}」把【${t.item}】交给了「${t.to}」`).join("\n");
      msg += `\n本回合玩家间的物品转移:\n${tx}\n`;
    }
    msg += `\n请综合以上所有行动与互动推进剧情,生成下一回合,并在结尾分别给每位玩家新的行动选项。`;
    room.history.push({ role: "user", content: msg });
    room.reactions = [];
    room.transfers = [];
    room.round += 1;
    runAI(room);
  }

  socket.on("disconnect", () => {
    const room = rooms[joinedCode];
    if (!room) return;
    const p = room.players[socket.id];
    if (!p) return;
    // 不立刻删,给 90 秒重连宽限期,期间保留座位
    p.connected = false;
    const deadId = socket.id;
    p._graceTimer = setTimeout(() => {
      const r = rooms[joinedCode];
      if (!r || !r.players[deadId]) return;
      delete r.players[deadId];
      if (Object.keys(r.players).length === 0) {
        setTimeout(() => {
          if (rooms[joinedCode] && Object.keys(rooms[joinedCode].players).length === 0)
            delete rooms[joinedCode];
        }, 30 * 60 * 1000);
        return;
      }
      if (r.hostId === deadId) r.hostId = Object.keys(r.players)[0];
      broadcastRoom(r);
    }, 90 * 1000);
    broadcastRoom(room);
  });
});

httpServer.listen(PORT, () => {
  console.log(`AI 联机模拟器已启动: http://localhost:${PORT}`);
});
