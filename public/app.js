const socket = io();
let myCode = null;
let myId = null;
let room = null; // 最新房间视图

const $ = (id) => document.getElementById(id);

socket.on("connect", () => { myId = socket.id; });

// ---- 进入界面 ----
$("btnCreate").onclick = () => {
  const name = $("nick").value.trim() || "房主";
  socket.emit("createRoom", { name }, (res) => {
    if (res.ok) enterGame(res.code);
  });
};

$("btnJoin").onclick = () => {
  const name = $("nick").value.trim() || "玩家";
  const code = $("joinCode").value.trim().toUpperCase();
  if (!code) return alert("请输入房间码");
  socket.emit("joinRoom", { code, name }, (res) => {
    if (res.ok) enterGame(res.code);
    else alert(res.error || "加入失败");
  });
};

// ---- 白天 / 深夜主题 ----
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  try { localStorage.setItem("simTheme", t); } catch {}
  const label = t === "night" ? "☀️ 白天" : "🌙 深夜";
  const b1 = $("btnTheme"), b2 = $("btnThemeEntry");
  if (b1) b1.textContent = label;
  if (b2) b2.textContent = label;
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme");
  applyTheme(cur === "night" ? "day" : "night");
}
(function initTheme() {
  let t = "day";
  try { t = localStorage.getItem("simTheme") || "day"; } catch {}
  applyTheme(t);
})();
$("btnTheme").onclick = toggleTheme;
$("btnThemeEntry").onclick = toggleTheme;

function enterGame(code) {
  myCode = code;
  $("entry").classList.add("hidden");
  $("game").classList.remove("hidden");
  $("roomInfo").textContent = "房间 " + code;
}

// ---- 侧栏开关 ----
$("btnPhone").onclick = () => $("sidebar").classList.toggle("hidden");
$("closeSidebar").onclick = () => $("sidebar").classList.add("hidden");

// ---- 房主设置 ----
$("apiTemp").oninput = (e) => ($("tempVal").textContent = e.target.value);
$("btnSaveCfg").onclick = () => {
  const baseUrl = $("apiBase").value.trim();
  const key = $("apiKey").value.trim();
  const model = $("apiModel").value.trim();
  const missing = [];
  if (!baseUrl) missing.push("API Base URL");
  if (!key) missing.push("API Key");
  if (!model) missing.push("模型名");
  if (missing.length) {
    alert("这几项还没填,填齐才能保存生效:\n· " + missing.join("\n· "));
    return;
  }
  socket.emit("configRoom", {
    code: myCode,
    api: { baseUrl, key, model, temperature: parseFloat($("apiTemp").value) },
    systemPrompt: $("sysPrompt").value,
  });
  flash($("btnSaveCfg"), "♡ 已保存");
};

$("btnStart").onclick = () => {
  if (!room?.hasApi)
    return alert("API 还没保存成功。请确认 base_url、key、模型名三项都填了,再点「保存设置」,看到按钮闪出“♡ 已保存”后再开始。");
  socket.emit("startGame", { code: myCode });
};
$("btnForce").onclick = () => socket.emit("forceAdvance", { code: myCode });

$("btnGenTpl").onclick = () => {
  socket.emit("genTemplate", { code: myCode });
  flash($("btnGenTpl"), "✎ 生成中...");
};
socket.on("tplStatus", (s) => {
  if (s === "生成中") $("btnGenTpl").textContent = "✎ 生成中...";
  else $("btnGenTpl").textContent = "✎ 生成角色填空模板";
});

// ---- 角色设定 ----
$("btnSaveChar").onclick = () => {
  socket.emit("setCharacter", { code: myCode, character: $("charInput").value });
  flash($("btnSaveChar"), "♡ 已保存角色");
};

// ---- 提交行动 ----
$("btnSubmit").onclick = () => {
  socket.emit("submitAction", { code: myCode, action: $("actText").value.trim() });
  $("actText").value = "";
};

function flash(btn, txt) {
  const old = btn.textContent;
  btn.textContent = txt;
  setTimeout(() => (btn.textContent = old), 1200);
}

// ---- 接收房间状态 ----
let lastTpl = "";
socket.on("room", (r) => {
  room = r;
  // 房主生成了新填空模板 → 若玩家角色框还空着,自动填入模板方便照着填
  if (r.charTemplate && r.charTemplate !== lastTpl) {
    lastTpl = r.charTemplate;
    const box = $("charInput");
    if (box && !box.value.trim()) box.value = r.charTemplate;
  }
  renderPlayers();
  updateControls();
});

socket.on("errorMsg", (m) => addSys("⚠️ " + m));

// 新加入者补历史
socket.on("historyDump", (history, round) => {
  $("story").innerHTML = "";
  for (const m of history) {
    if (m.role === "assistant") addAI(m.content);
  }
});

// ---- 流式剧情 ----
let curMsg = null;
let curRaw = "";
socket.on("aiStart", ({ round }) => {
  addSys(`—— 第 ${round} 回合 · AI 正在生成 ——`);
  curRaw = "";
  curMsg = document.createElement("div");
  curMsg.className = "msg ai cursor";
  $("story").appendChild(curMsg);
  scrollStory();
});
socket.on("aiDelta", (delta) => {
  if (!curMsg) return;
  curRaw += delta;
  curMsg.innerHTML = marked.parse(curRaw);
  scrollStory();
});
socket.on("aiEnd", ({ content }) => {
  if (curMsg) {
    curMsg.classList.remove("cursor");
    curMsg.innerHTML = marked.parse(content);
  }
  curMsg = null;
  scrollStory();
});

// ---- 渲染辅助 ----
function addAI(text) {
  const d = document.createElement("div");
  d.className = "msg ai";
  d.innerHTML = marked.parse(text);
  $("story").appendChild(d);
  scrollStory();
}
function addSys(text) {
  const d = document.createElement("div");
  d.className = "msg sys";
  d.textContent = text;
  $("story").appendChild(d);
  scrollStory();
}
function scrollStory() {
  const s = $("story");
  s.scrollTop = s.scrollHeight;
}

// ---- 玩家列表渲染 ----
function renderPlayers() {
  if (!room) return;
  const list = $("playerList");
  list.innerHTML = "<h3>👥 玩家 (" + room.players.length + ")</h3>";
  for (const p of room.players) {
    const card = document.createElement("div");
    card.className = "pcard";
    let badges = "";
    if (p.isHost) badges += '<span class="badge host">房主</span>';
    if (room.phase === "acting") {
      badges += p.submitted
        ? '<span class="badge ok">已提交</span>'
        : '<span class="badge wait">等待</span>';
    }
    const me = p.id === myId ? " (我)" : "";
    const av = avatar(p.name);
    card.innerHTML =
      `<div class="pcard-head">` +
      `<span class="avatar" style="background:${av.bg};color:${av.fg}">${av.ch}</span>` +
      `<div class="pcard-body">` +
      `<div class="pname">${escapeHtml(p.name)}${me}${badges}</div>` +
      (p.character ? `<div class="pchar">${escapeHtml(p.character.split("\n")[0])}</div>` : "") +
      `</div></div>` +
      (p.submitted && p.action ? `<div class="paction">♡ ${escapeHtml(p.action)}</div>` : "");
    list.appendChild(card);
  }
}

// ---- 控件状态 ----
function updateControls() {
  if (!room) return;
  const isHost = room.hostId === myId;
  $("hostPanel").classList.toggle("hidden", !isHost);
  $("roundInfo").textContent = room.round > 0 ? "第 " + room.round + " 回合" : "未开始";

  // 房主开始按钮:仅大厅阶段显示
  $("btnStart").classList.toggle("hidden", room.phase !== "lobby");
  $("btnForce").classList.toggle("hidden", !(isHost && room.phase === "acting"));

  // 角色设定:仅大厅阶段
  $("charSetup").classList.toggle("hidden", room.phase !== "lobby");
  // 行动输入:acting 阶段且自己没提交;已提交则显示等待条
  const me = room.players.find((p) => p.id === myId);
  const acting = room.phase === "acting";
  const canAct = acting && me && !me.submitted;
  $("actInput").classList.toggle("hidden", !canAct);
  $("waitState").classList.toggle("hidden", !(acting && me && me.submitted));

  if (acting) {
    const done = room.players.filter((p) => p.submitted).length;
    const total = room.players.length;
    $("submitHint").textContent = `已提交 ${done}/${total}`;
    $("waitHint").textContent =
      done >= total
        ? "♡ 全员已提交,AI 正在续写..."
        : `♡ 已提交,等其他人... (${done}/${total})`;
  }
}

// 按昵称生成柔粉系头像(首字 + 哈希取色)
const AVATAR_PALETTE = [
  { bg: "#f2d7df", fg: "#b86b82" },
  { bg: "#f0c2d1", fg: "#5a4a4f" },
  { bg: "#f6e3ea", fg: "#b86b82" },
  { bg: "#e8d3d9", fg: "#3b2f33" },
  { bg: "#fbe0e8", fg: "#a85a72" },
];
function avatar(name) {
  const n = (name || "?").trim();
  const ch = n ? [...n][0].toUpperCase() : "♡";
  let h = 0;
  for (let i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) >>> 0;
  const c = AVATAR_PALETTE[h % AVATAR_PALETTE.length];
  return { ch, bg: c.bg, fg: c.fg };
}

function escapeHtml(s) {
  return (s || "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}
