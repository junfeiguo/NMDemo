# Namak Mandi 网站聊天机器人和语音助手

## 放到 GitHub 仓库的哪里（仓库 junfeiguo/NMDemo）

```
NMDemo/                        ← 仓库根目录，index.html 就在这里
├─ index.html                  ← 只需要在 </body> 之前加 4 行（见 index-snippet.html）
├─ chatbot/                    ← 新建文件夹，网站要用的 3 个文件
│   ├─ chatbot.css
│   ├─ chatbot.js
│   └─ knowledge.js            ← 餐厅信息、营业时间、菜单价格；改资料就改这里
├─ worker/                     ← 新建文件夹，AI 后台代码。GitHub Pages 不会运行它，要部署到 Cloudflare
│   ├─ worker.bundle.js        ← 单文件版，用 Cloudflare 网页后台部署时用这个
│   ├─ worker.js、prompt.js、kb.js、wrangler.toml、package.json、make-phone-prompt.mjs   ← 用命令行部署时用
└─ voice/                      ← 新建文件夹，真电话号码的说明和提示词（可选）
    ├─ README.md
    └─ phone-agent-prompt.md
```
把 zip 解压后，`chatbot/`、`worker/`、`voice/` 三个文件夹上传到仓库根目录，再按下面第 1 步改 `index.html`。

## 它现在能做什么
1. **机器人按钮**（网站右侧）：打开聊天窗口，客人可以问营业时间、地址、菜单价格、素食、过敏原、清真、Sajji、礼品卡、活动包场，也可以订座和点餐。
2. **电话按钮**（右侧）：打开语音通话界面。客人用麦克风说话，助手用英式英语回答和朗读。需要 Chrome、Edge 或 Safari，网页必须是 https（GitHub Pages 是）。
3. **两种模式**：
   - 没有部署后台时（默认）：用内置的规则助手，能回答常见问题，并引导客人填完订座或点餐信息，生成一条消息，客人点"Send on WhatsApp"或复制后发给餐厅。**这时没有 AI，也没有任何东西会自动发给餐厅。**
   - 部署后台并填入地址后：由 Claude 回答，语言更自然，也能订座和点餐，并把请求发到你设置的通知渠道。
4. 助手会说明自己是自动助手，不是真人。订座和点餐都是"请求"，餐厅回复之前不算确认。助手不会说任何菜品不含过敏原，也不收银行卡信息。

## 第 1 步：把按钮加到网站（几分钟）
打开仓库里的 `index.html`，在 `</body>` 之前加上 `index-snippet.html` 里的 4 行，提交。刷新网站就能看到右侧两个按钮。此时用的是内置规则助手。

## 第 2 步：开启 AI（可选，约 20 分钟）
1. 在 [Anthropic Console](https://console.anthropic.com) 创建 API key，并设置每月花费上限。费用按使用量计，默认用 `claude-haiku-5-5`，成本较低。
2. 准备通知渠道：在 Slack 或 Discord 建一个频道并创建 Incoming Webhook，得到一个网址。也可以用 Zapier 或 Make 的 webhook 转成邮件或短信。
3. 注册免费的 Cloudflare 账号，进入 Workers & Pages，新建 Worker，把 `worker/worker.bundle.js` 的全部内容粘贴进编辑器并部署。
4. 在这个 Worker 的 Settings → Variables and Secrets 添加：`ANTHROPIC_API_KEY`（Secret）、`NOTIFY_WEBHOOK`（Secret）。可选：`ALLOWED_ORIGINS`（默认只允许 `https://junfeiguo.github.io`，以后换成自己的域名时要加上）、`MODEL`。
5. 复制 Worker 地址，加上 `/chat`，填到 `index.html` 里的 `endpoint`，提交。
6. 测试：在网站上说"Book a table for 2 tomorrow at 7pm"，走完流程后检查通知渠道是否收到请求。

命令行方式：进入 `worker/` 文件夹，运行 `npx wrangler login`，`npx wrangler deploy`，再用 `npx wrangler secret put ANTHROPIC_API_KEY` 和 `npx wrangler secret put NOTIFY_WEBHOOK` 设置密钥。

## 第 3 步：真电话号码（可选）
见 `voice/README.md`。

## 改资料
- 营业时间、菜单、价格、常见问答：改 `chatbot/knowledge.js`，同样的内容也要同步到 `worker/kb.js`（两个文件是同一份数据）。改完后如果用了真电话，重新运行 `node make-phone-prompt.mjs`，把新的提示词粘贴到平台。
- 外卖配送区和价格在网站上还是演示数据，助手不会报价，只会说通过 Uber Eats、Deliveroo 或 Just Eat 外卖。

## 已测试和未测试
- 已测试：聊天界面和内置助手（电脑和手机尺寸）、订座和点餐流程、语音通话流程（用模拟的麦克风和朗读测试）、后台的校验逻辑（用模拟的 Claude 回复测试）、按钮不会盖住网站原有的 WhatsApp 按钮。
- 没有测试：真实的 Claude 调用、通知渠道的发送、真实麦克风和语音朗读的音质、真电话平台。这些需要你的 API key 和账号，请按上面的步骤上线前自己各试一遍。
