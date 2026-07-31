# 🎲 AI 联机模拟器

和朋友一起玩 AI 主持的文字游戏。AI 当游戏主持人,每人扮演一个角色,回合制推进——所有人提交行动后,AI 生成下一段剧情。

## 本地运行

```bash
npm install
npm start
```

打开 http://localhost:3000

## 玩法

1. **房主**点「创建房间」,拿到 6 位房间码。
2. 点右上角「👥 玩家」→ 房主设置里填:
   - **API Base URL**:如 `https://api.deepseek.com/v1`(OpenAI 兼容格式)
   - **API Key**:你自己的 key(只存在服务端,不会发给其他玩家)
   - **模型名**:如 `deepseek-chat`
   - **模拟器指令**:把你的游戏设定粘进去(见 `prompt-template.txt`)
   - 保存设置
3. **朋友**输房间码 + 昵称加入,各自在底部填「角色设定」。
4. 房主点「🎬 开始游戏」→ AI 生成开场。
5. 每回合每人提交行动,全员提交后自动推进(房主也可「⏭️ 强制推进」)。

## 部署到云端(Render 示例)

1. 把这个文件夹推到 GitHub 仓库。
2. Render → New → Web Service → 连你的仓库。
3. 环境选 Node,Build Command `npm install`,Start Command `npm start`。
4. 部署完拿到固定网址,发给朋友即可。

Railway / Fly.io 同理,程序读 `PORT` 环境变量,零改动。

## 说明

- 房间状态存内存,并把剧情落盘到 `saves/<房间码>.json`,方便你留档。
- 没有账号系统,任何拿到房间码的人都能进——房间码别发到公开场合。
- API key 走服务端代理,其他玩家看不到。
