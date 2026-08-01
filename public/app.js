const socket = io();
let myCode = null;
let myId = null;
let myName = null;
let room = null; // 最新房间视图

const $ = (id) => document.getElementById(id);

// 持久身份:重连/刷新后凭它认领回原座位
function getClientId() {
  let id;
  try { id = localStorage.getItem("simClientId"); } catch {}
  if (!id) {
    id = "c" + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try { localStorage.setItem("simClientId", id); } catch {}
  }
  return id;
}
const clientId = getClientId();

function saveSession() {
  try {
    localStorage.setItem("simSession", JSON.stringify({ code: myCode, name: myName }));
  } catch {}
}
function clearSession() {
  try { localStorage.removeItem("simSession"); } catch {}
}

socket.on("connect", () => { myId = socket.id; });

// ---- 进入界面 ----
$("btnCreate").onclick = () => {
  myName = $("nick").value.trim() || "房主";
  socket.emit("createRoom", { name: myName, clientId }, (res) => {
    if (res.ok) { enterGame(res.code); saveSession(); }
  });
};

$("btnJoin").onclick = () => {
  myName = $("nick").value.trim() || "玩家";
  const code = $("joinCode").value.trim().toUpperCase();
  if (!code) return alert("请输入房间码");
  socket.emit("joinRoom", { code, name: myName, clientId }, (res) => {
    if (res.ok) { enterGame(res.code); saveSession(); }
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
$("btnRefresh").onclick = () => {
  if (myCode) socket.emit("refreshRoom", { code: myCode });
};
$("btnReload").onclick = () => location.reload();

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
  flash($("btnSaveCfg"), "♡ 保存中...");
  // 保存后等一下刷新,显示实际 hasApi 状态
  setTimeout(() => {
    socket.emit("refreshRoom", { code: myCode });
    setTimeout(() => {
      if (room && room.hasApi) {
        flash($("btnSaveCfg"), "✓ 已生效");
      } else {
        flash($("btnSaveCfg"), "✗ 未生效");
        alert("保存未生效!可能原因:\n1. 三个框没填齐\n2. 你不是房主\n3. 房间码错了\n点右上刷新按钮重试。");
      }
    }, 200);
  }, 300);
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
socket.on("sysMsg", (m) => addSys("✦ " + m));

// 断线重连:凭 clientId 认领回原座位并补历史
socket.on("disconnect", () => {
  if (myCode) addSys("⚠️ 连接断开,正在自动重连...");
});
socket.on("connect", () => {
  myId = socket.id;
  if (myCode) {
    socket.emit("rejoin", { code: myCode, clientId, name: myName }, (res) => {
      if (res && res.ok) addSys("✦ 已重连,继续游戏");
      else { addSys("⚠️ 重连失败:" + (res && res.error || "房间已关闭")); }
    });
  }
});

// 页面刚加载:检查是否有上次的房间,显示"继续"按钮(不自动进)
(function checkLastSession() {
  let s;
  try { s = JSON.parse(localStorage.getItem("simSession") || "null"); } catch {}
  if (!s || !s.code) return;
  const btn = $("btnResume");
  btn.classList.remove("hidden");
  btn.onclick = () => {
    myName = s.name;
    socket.emit("rejoin", { code: s.code, clientId, name: s.name }, (res) => {
      if (res && res.ok) { enterGame(s.code); addSys("✦ 已回到房间 " + s.code); }
      else {
        alert("上次的房间已关闭或过期");
        clearSession();
        btn.classList.add("hidden");
      }
    });
  };
})();

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
    if (p.connected === false) badges += '<span class="badge off">掉线中</span>';
    if (room.phase === "acting") {
      badges += p.submitted
        ? '<span class="badge ok">已提交</span>'
        : '<span class="badge wait">等待</span>';
    }
    const isMe = p.id === myId;
    const me = isMe ? " (我)" : "";
    const av = avatar(p.name);
    // 物品:自己的物品带"给"按钮
    let itemsHtml = "";
    if ((p.items || []).length) {
      itemsHtml =
        `<div class="pitems">🎒 ` +
        p.items
          .map((it) =>
            isMe
              ? `<span class="chip give" data-item="${escapeHtml(it)}">${escapeHtml(it)} ⇄</span>`
              : `<span class="chip">${escapeHtml(it)}</span>`
          )
          .join(" ") +
        `</div>`;
    }
    let statusHtml = "";
    if ((p.status || []).length) {
      statusHtml =
        `<div class="pstatus">✧ ` +
        p.status.map((s) => `<span class="chip st">${escapeHtml(s)}</span>`).join(" ") +
        `</div>`;
    }
    // 别人已提交的行动:acting 阶段可"回应"
    let actionHtml = "";
    if (p.submitted && p.action) {
      actionHtml = `<div class="paction">♡ ${escapeHtml(p.action)}`;
      if (!isMe && room.phase === "acting") {
        actionHtml += ` <button class="react-btn mini" data-id="${p.id}" data-name="${escapeHtml(p.name)}">↩ 回应</button>`;
      }
      actionHtml += `</div>`;
    }
    card.innerHTML =
      `<div class="pcard-head">` +
      `<span class="avatar" style="background:${av.bg};color:${av.fg}">${av.ch}</span>` +
      `<div class="pcard-body">` +
      `<div class="pname">${escapeHtml(p.name)}${me}${badges}</div>` +
      (p.character ? `<div class="pchar">${escapeHtml(p.character.split("\n")[0])}</div>` : "") +
      `</div></div>` +
      itemsHtml + statusHtml + actionHtml;
    list.appendChild(card);
  }
  bindCardButtons();
  renderReactions();
}

// 绑定卡片上的"回应""给物品"按钮
function bindCardButtons() {
  document.querySelectorAll(".react-btn").forEach((b) => {
    b.onclick = () => {
      const text = prompt(`回应「${b.dataset.name}」的行动:`);
      if (text && text.trim())
        socket.emit("react", { code: myCode, targetId: b.dataset.id, text: text.trim() });
    };
  });
  document.querySelectorAll(".chip.give").forEach((c) => {
    c.onclick = () => {
      const others = room.players.filter((p) => p.id !== myId);
      if (!others.length) return alert("暂时没有其他玩家可以给。");
      const names = others.map((p, i) => `${i + 1}. ${p.name}`).join("\n");
      const pick = prompt(`把【${c.dataset.item}】给谁?输入编号:\n${names}`);
      const idx = parseInt(pick, 10) - 1;
      if (others[idx])
        socket.emit("giveItem", { code: myCode, toId: others[idx].id, item: c.dataset.item });
    };
  });
}

// 渲染本回合的相互回应记录
function renderReactions() {
  const box = $("reactionLog");
  if (!box) return;
  const rx = room.reactions || [];
  if (!rx.length) { box.classList.add("hidden"); box.innerHTML = ""; return; }
  box.classList.remove("hidden");
  box.innerHTML =
    `<div class="rx-title">✧ 本回合互动</div>` +
    rx.map((r) => `<div class="rx-item"><b>${escapeHtml(r.from)}</b> → <b>${escapeHtml(r.to)}</b>:${escapeHtml(r.text)}</div>`).join("");
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
        ? "♡ 全员已提交,可点开玩家互相回应,等房主推进"
        : `♡ 已提交,可回应他人,等其他人... (${done}/${total})`;
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
