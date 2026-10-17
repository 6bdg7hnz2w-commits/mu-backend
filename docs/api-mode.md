# 沐 (CC) 并线 API：接口约定

一条聊天线，两个"身体"：沐 (CC) 聊天页的记录只有 bridge 这一份；手动切到 API 时，她发的消息
bridge 照样存，但不交给 VPS 上的 Claude Code，改由后端调中转站的模型回，回的话再写回 bridge，
所以聊天页、历史、SSE 都还是同一条。切回 CC 后，bridge 在下一条交给 CC 的消息前面附上这段时间
API 替他聊过的内容（交接），他接得上。

参考了 Tidal_Echo 的 `/app/brain` 开关和"单身体原则"（同一时刻只有一个身体接消息）。

```
                       ┌─ brain=cc ─► CC（VPS，原样）
她 → /api/cc/send → bridge /send（存 inbox）
                       └─ brain=api ─► 后端 lib/apiTurn.js 跑一轮
                                        │ GET bridge /history 拼上文（+ /persona、记忆、日记）
                                        │ 调中转站模型（选中的模型 + 分组的 key）
                                        ▼
                         POST bridge /reply {via:'api'} → 存 outbox、SSE 推前端、正在输入灭
                         失败：POST bridge /system {kind:'reply_failed'} → 前端"再叫他一下"
```

---

## 一、后端给前端的接口（都要 APP 口令）

### `GET /api/cc/api-models`
模型目录（唯一来源是 `lib/apiModels.js`，前端不写死）。

```jsonc
{
  "default": { "model": "[K]claude-opus-4-6-thinking", "group": "default" },
  "families": [
    {
      "key": "opus-4-6", "name": "Opus 4.6",
      "options": [
        {
          "id": "default|[K]claude-opus-4-6-thinking", // 分组|模型名，前端拿来当 key
          "model": "[K]claude-opus-4-6-thinking",       // 发给中转站的模型名（带 [X] 前缀）
          "group": "default",                            // 中转站的令牌分组，决定用哪把 key
          "series": "K",                                 // A / hybrid / B / K / P；fable 是分组名
          "label": "K · thinking",                       // 第二层列表里显示的名字
          "desc": "kiro，RFv3对RP与人机恋各场景表现调优",   // 显示在 label 下面的介绍
          "thinking": true,                              // 有思考过程，聊天页自动显示
          "ready": true                                  // 这个分组的 key 配了没有；false 时灰掉
        }
      ]
    }
  ]
}
```

### `GET /api/cc/brain`
```jsonc
{ "supported": true, "target": "api",            // "cc" | "api"
  "model": "[K]claude-opus-4-6-thinking", "group": "default",   // 上次选的 API 模型（切回 CC 也留着）
  "option": { /* 同上面的 option，找不到时 null */ },
  "family": { "key": "opus-4-6", "name": "Opus 4.6" } }        // 找不到时 null
```
bridge 还没更新（`/brain` 404）时返回 `{ "supported": false, "target": "cc", "model": null, "group": null, "option": null, "family": null }`；
bridge 连不上 502。

### `POST /api/cc/brain`
- `{ "target": "cc" }`：切回 CC，选过的模型留着。
- `{ "target": "api" }`：用上次选的模型；从来没选过就用 `default`。
- `{ "target": "api", "model": "...", "group": "..." }`：选模型（同时切到 API）。
- 400：target 不对、模型/分组不在目录里、这个分组的 key 没配（`ready:false`）。
- 返回和 `GET` 一样的形状。

### `POST /api/cc/api-test`
`{ "model": "...", "group": "..." }` → 真发一句让模型回 pong，看通不通：
`{ "ok": true, "ms": 2310, "text": "pong" }` 或 `{ "ok": false, "ms": 1200, "error": "供应商返回的错误原文" }`（HTTP 都是 200；参数不对 400）。

### `/api/cc/send`、`/api/cc/retry`
请求不变。响应多一个 `brain`（`"cc"` / `"api"`，bridge 给的原样带回；旧 bridge 没有这个字段）。
API 模式下后端在回完前端之后自己排一轮 API，前端照常等 SSE。

### 历史和 SSE 里 API 回的消息
`/api/cc/history`、`/api/cc/events` 原样透传 bridge，API 回的那条（role `assistant`）多这几个字段：
```jsonc
{ "id": "...", "role": "assistant", "text": "...", "time": "...", "seq": 123, "pid": "api-...",
  "via": "api", "model": "[K]claude-opus-4-6-thinking", "group": "default",
  "thinking": "思考过程原文（没有就不带这个字段）", "reply_to": "她那条的 id" }
```

---

## 二、bridge 要加的（VPS 上 /opt/mu-bridge，全部只认 BRIDGE_TOKEN）

> 交给 VPS 上的 CC 实现。现有接口和行为不变的地方不写。旧前端、旧后端遇到新字段直接忽略。

1. **开关** `GET /brain` → `{ "target": "cc"|"api", "api_model": string|null, "api_group": string|null }`；
   `POST /brain`，body 里给了哪个字段就改哪个（`target` 只收 `cc`/`api`，别的 400），没给的保持原值，
   落盘（重启后还在），返回改后的完整状态。`api_model`/`api_group` bridge 只存不管（后端已校验）。
   默认 `target: "cc"`。

2. **`POST /send`**：`target=api` 时照常落库（id、seq、client_id 去重、图片文件校验都不变），
   **不交给 CC**，这条消息记上 `routed:"api"`，SSE 推 `{type:'typing', on:true, since}`，
   响应在原有字段外加 `brain:"api"`。`target=cc` 时行为不变，响应加 `brain:"cc"`。
   body 里可能多一个 `rhythm`（字符串，≤500 字）：她这条是怎么打出来的（打了多久、停了几次、有没有打了没发），
   只有时间没有内容。存在这条消息上（`/history` 里带着，API 那边要读）；**CC 接的时候**附在她这条后面交给 CC：
   `【指尖的语气——以下是桦桦打这条消息的节奏，供你感受她当下的状态，不要复述具体数字，也不要主动提起】<rhythm>`。
   前端不显示它。

3. **`POST /retry {id}`**：`target=api` 时不叫 CC：找不到 404，否则 SSE 推 typing on，返回 `{ ok:true, brain:"api" }`。
   这时**不要**按"她这条后面有没有沐的话"回 409：API 回的那条 seq 可能排在她后来发的消息后面，
   按位置判断会把该回的拦掉。要不要回由后端判断（它按 `reply_to` 认）。

4. **`POST /reply`**（新，后端用）：
   `{ text, thinking?, model, group?, reply_to, turn_id }` → 存成沐的一条消息：
   `role:"assistant"`、`via:"api"`、`model`、`group`、`thinking`（有才存）、`reply_to`、`pid: turn_id`，
   照常分配 id、seq、time，SSE 推这条，再推 typing off。
   同一个 `turn_id` 来第二次直接返回第一次存的那条（后端重试不会出两条）。
   中途已经切回 CC 了也照收（她那条该有个回音）。返回 `{ ok:true, id, seq, time }`。

5. **`POST /system`**（新，后端用）：`{ kind:"reply_failed", reply_to, error? }` → 和现在 CC 没回上来时
   一样记一条系统事件（前端据此显示"他这次没回上来 · 再叫他一下"），推 SSE，typing off。只收 `reply_failed`。

6. **`POST /typing`**（新，后端用）：`{ on: bool }` → SSE 推 `{type:'typing', on, since?}`。
   API 模式下 typing 的超时规则和 CC 一样。

7. **`/history`、SSE**：API 回的那条带上第 4 条里的字段（`via`、`model`、`group`、`thinking`、`reply_to`）；
   她的消息里 API 接的那些带上 `routed:"api"`。

8. **`GET /persona`**（新）：`{ "text": "..." }`。人设抽成一个文件（例如 `/opt/mu-bridge/persona.md`），
   `~/.claude/CLAUDE.md` 里用一行 `@/opt/mu-bridge/persona.md` 引入，CC 和 API 读的是同一份。
   人设里只放"沐是谁、怎么说话"，CC 专用的工具说明（reply 工具、文件路径之类）留在 CLAUDE.md 里别放进来。
   没配就 404，后端会退回 Supabase `settings.system_prompt`。

9. **交接**：记住哪些消息是 API 接的、CC 还没见过。`target=cc` 之后 bridge **下一次**把消息交给 CC 时，
   在她这条前面附上：
   ```
   【你不在的时候，API 替你接着和她聊了这些（10-16 14:02 – 10-16 15:30）】
   [10-16 14:02] 她：……
   [10-16 14:03] 你（API · [K]claude-opus-4-6-thinking）：……
   ……（更早的 N 条没放进来，完整记录在 /opt/mu-bridge/<哪个文件>）
   【交接完了，下面是她刚发的】
   ```
   最多放最近 40 条 / 12000 字左右；她改过的消息用改后的版本；交过一次就算 CC 见过了。
   只在她下次说话时附，不主动叫醒 CC（不白费额度）。

10. **`/edit`**：`target=api` 时照常改、照常推更新，但不通知 CC（交接时会用改后的版本）。

---

## 三、后端怎么跑一轮 API（lib/apiTurn.js）

- **排队**：`/send`、`/retry` 返回 `brain:"api"` 就把她那条记进待回集合。从她最后一条算起等 2.5 秒
  （她连发几条只回一轮），同一时间只跑一轮；跑的时候又来了新的，跑完照样等满 2.5 秒再补一轮。
  她那条后面已经有 API 的回复了就不再回（重发去重）；CC 的话不算（这些消息 CC 没见过，
  刚切过来时 CC 上一轮晚到的话不是在回她这条）。重试较早那条时，它后面带 `routed:"api"` 还没回上的一起回。
- **上文**：`GET /history?limit=60`，只要她和沐的消息，按 seq 排，API 回的那条挪到它 `reply_to` 那条后面；
  从后往前按 token 估算截到预算内；同一边连着的几条合成一条；她的消息前面带 `[MM-DD HH:mm]`。
  这一轮要回的消息里的图片从 bridge 取回来转 base64 给模型看（最多 4 张），小的文本文件内联，
  其余文件、旧图片只留一句"[图片]""[文件: 名字]"。
- **system**：`/persona`（缓存 5 分钟；404 退回 `settings.system_prompt`）+ `VOICE_RULE`
  + 一段"现在是 API 替班，没有工具"的说明 + `memories` 最近 10 条 + 沐最近两篇日记
  + 这一轮要回的消息上的 `rhythm`（打字节奏，见第二节第 2 条）。
- **调模型**：选中的模型名原样发给中转站（`RELAY_BASE_URL`），key 按分组选（见下）。超时 180 秒。
  思考过程取 `reasoning_content` / `thinking`，或者正文开头的 `<think>…</think>` / `<thinking>…</thinking>`。
- **回写**：成功 → `POST /reply`；失败或正文为空 → `POST /system reply_failed`（她点"再叫他一下"会重跑）。
- **压缩**：每次 API 回完，看 bridge 里还没压过的记录（最多看最近 200 条）：超过 `settings.compress_threshold`
  （默认 12000 token）而且多于 `compress_keep_rounds × 2`（默认 30）条，就把较早的那段压成一条记忆
  （`memories`，`session_id 'cc'`，`metadata.upto_time` 记到哪条为止），之后拼上文从那以后开始，压掉的那段靠记忆。
  bridge 里的原记录一条不动。压缩模型按顺序试，失败就换下一个：
  `[A]claude-hybrid` → `hybrid2` → `hybrid3` → `[K]` Opus 4.6 / 4.7 / 4.8 → `[B]` Opus 4.6 / 4.7 / 4.8 → `[P]` Opus 4.8 / 5.5（`lib/apiModels.js` 的 `COMPRESS_CHAIN`）。
- **mochi**：API 回的话用 DeepSeek 打情绪标签，`/api/mochi/mood` 读最近一条（只在内存里）。CC 的回复不经后端，不打标签。

## 四、中转站的 key（Render 环境变量）

默认所有模型共用一把 `RELAY_API_KEY`。中转站（new-api）的令牌有"分组"，有的 key 只能调自己分组的模型；
如果某个分组用共用 key 调不通（设置页"测试一下"报 no available channel），就在中转站「令牌」里建一把那个分组的，
填进对应的环境变量，后端优先用它：

| 分组 | 单独的环境变量（可选） | 用在 |
|---|---|---|
| default | `RELAY_KEY_DEFAULT` | 所有 Opus（A/B/K/P、hybrid） |
| claude-awsb | `RELAY_KEY_CLAUDE_AWSB` | Fable 5 |
| claude-ccmax | `RELAY_KEY_CLAUDE_CCMAX` | Fable 5 |
| claude-or | `RELAY_KEY_CLAUDE_OR` | Fable 5.1 |

规则：分组名转大写、非字母数字换成 `_`，前面加 `RELAY_KEY_`；没配就用 `RELAY_API_KEY`。

可选：`API_TURN_DEBOUNCE_MS`（默认 2500）、`API_TURN_TIMEOUT_MS`（默认 180000）。
