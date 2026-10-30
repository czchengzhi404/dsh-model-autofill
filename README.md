# dsh-model-autofill

DeepSeek Harness 插件：**在会话里把渠道接进来，并自动把模型元数据补到真实值。**

- **会话内导入**：把 `baseURL` 和凭据交给 Agent，插件探测端点、写进配置、把 key 存进 DSH 凭据库——配置里只留 `apiKeyEnv` 引用。
- **`/v1` 自动加减**：`https://host` 与 `https://host/v1/models` 都探一遍，留能通的那个。
- **元数据自动补全**：`contextWindow`、`maxTokens`、`input`/`inputModalities`、`reasoningEfforts`/`reasoningLevels`、`name`，逐个模型按 models.dev 填，**不套统一档位**。
- **保存即生效**：在设置页加完渠道保存，插件监听到 `settings/document-updated` 就自动补齐。
- **枚举不写死**：字段名与可选值都从运行时 schema 读取，DSH 升级自动跟上。

## 为什么是插件

Skill 是"指令"，要等 Agent 判断该用才执行；插件挂在 DSH 运行时里，**保存那一刻**就能自动完成，并且走的是和设置页完全相同的写入路径（`ctx.settings.mutate`，带 revision 冲突检查，落点是 `cordis.patch.yml`）。

## 安装

### CLI profile（`web` / `headless`）

```bash
dsh plugin --profile web add /path/to/dsh-model-autofill
```

包内声明了 `dsh.bundle`（指向自带的 `cordis.patch.yml`），所以 `add` 会把它注册成 profile 层并自动激活——**不用手写条目**。要改默认选项时，再按 id 覆盖：

```yaml
# profile 的 cordis.patch.yml
- id: model-autofill
  name: dsh-model-autofill
  config:
    autoFillOnStart: true
```

### Desktop 应用

`desktop` profile 由 Electron 独占，`dsh plugin --profile desktop` 会被拒绝。用应用内的插件管理界面，或在 profile 目录里装好后加补丁条目：

```bash
cd ~/.dsh/profiles/desktop && pnpm add /path/to/dsh-model-autofill
```

## 用法

装好后在会话里直接说：

> 帮我导入这个渠道：名称 `myrelay`，地址 `https://relay.example.com`，凭据名 `MYRELAY_API_KEY`，模型用 `deepseek-v4-pro, glm-5.3-flash`。

> 这个渠道端点上还有些新模型，同步进来并补全参数。

> 把所有模型缺的上下文/输出/图片/推理等级补一下，先 dry-run 给我看。

### 三个工具

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `provider_import` | 探测 `/v1` → 写 provider → 存/引用凭据 → 补全元数据 | `name`, `baseURL`, `apiKeyEnv`（推荐）或 `apiKey`, `models`, `displayName`, `dryRun` |
| `provider_sync_models` | 用该渠道的凭据拉取 `/models`，把配置里没有的模型加进来（有 `models` 列表就追加；目录型路由写 `modelOverrides`），再补全 | `provider`, `models`, `dryRun` |
| `model_capabilities_autofill` | 只补元数据，不碰渠道 | `provider`, `force`, `dryRun` |

### 凭据的两种给法

| 方式 | 适合 | 行为 |
|---|---|---|
| `apiKeyEnv: "MYRELAY_API_KEY"`（**推荐**） | key 已在凭据库/环境变量里 | 插件用 `ctx.credentials.resolve()` **宿主侧**读取，仅用于探测；**密钥不进入会话** |
| `apiKey: "sk-..."` | 手上只有明文 key，想顺手存起来 | 写入 DSH 凭据库，配置只留引用；但报告会提示**该 key 经过了本次会话**（可能留在转录里） |

## 补什么、按什么规则

| 字段 | 来源 | 规则 |
|---|---|---|
| `contextWindow` | models.dev `limit.context` | 优先规范条目（`vendor/id`），其次精确 id，最后同族里最强的快照；带合理性上限，避免被中转站夸张值带偏 |
| `maxTokens` | models.dev `limit.output` | 同上，再乘 `margin`（默认 0.85）并对齐 1024，下限 4096 |
| `input` / `inputModalities` | models.dev `modalities.input` | 任一来源声明 `image`/`video` 即视为原生视觉；**字段名按命名空间自动判断**（pi-ai 用 `input`，DeepSeek 适配器用 `inputModalities`） |
| `reasoningEfforts` / `reasoningLevels` | models.dev `reasoning_options` | 取并集映射成 DSH 等级（`none→off`，其余同名）；纯开关模型用 `toggleLevels`；**写 dict 还是数组由 schema 决定** |
| `name` | models.dev `name` | 可选厂商前缀（`nameStyle: "vendor"`） |

**默认只填空字段**：任何你手动设过的非空值都不动，除非 `force: true`。

### 协议守卫

各协议对推理等级的 wire 拼写不同，猜错会直接报错。因此默认只在 `reasoningProtocols`（默认 `openai-completions` / `openai-responses`）上写推理等级；遇到 `anthropic-messages` 之类会**跳过并在报告里说明**，要强制就设 `forceReasoning: true`。

## 触发时机

| 触发 | 说明 |
|---|---|
| 启动 | 有界重试阶梯（默认 1s / 3s / 8s），设置服务还没就绪会自动重试 |
| 设置变更 | 监听 `settings/document-updated`；命名空间命中才触发，去抖 800ms |
| 配置重载 | `loader/volatile-update`、`app-boot/config-reload` |
| 定时 | `recheckMs`（默认 6 小时，仅刷新目录并补缺；已 `unref`，不会拖住进程） |

每一轮**只补缺失**，所以没有可补项时**不会产生任何写入**（不会自己触发自己）。

## 目录来源与保鲜

三层叠加，单源失败不影响其余：

1. **包内离线快照** `data/models.dev.json`（构建时生成，首启离线可用）
2. **磁盘缓存**（`cacheTtlMs`，默认 24h）
3. **实时拉取** `https://models.dev/api.json`

刷新快照：`npm run build:snapshot`。

**枚举保鲜**：`input` 的取值和推理等级列表不是写死的，而是从运行中的 Config schema（`settings.describe()` 暴露的 `{uid, refs}` 表）里解析 `inner` / `sKey` 得到。DSH 新增等级或换字段名，插件读到的就是新集合；models.dev 出现无法映射的取值会写进报告，而不是静默丢弃。

## 安全与保守模式

- **不覆盖**：默认只填缺失字段。
- **密钥不进配置**：`apiKeyEnv` 引用 + DSH 凭据库（`0600` 权限文件；DSH 本地凭据库本身不加密，这是 DSH 原生机制）。
- **fail-closed 模式**：`strict: true` 时只填 `mapping` 里显式声明的 id，其余一律跳过并说明原因；`mapping[id]: false` 表示显式不管。
- **排外**：`excludeProviders` 让某渠道完全不被接管。
- **可预演**：三个工具都支持 `dryRun`。

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `enabled` / `watchSettings` | `true` | 总开关 / 是否挂事件触发 |
| `namespaces` | `["llm-pi-ai","llm-deepseek"]` | 要审计的配置条目 |
| `autoFillOnStart` / `bootDelays` | `true` / `[1000,3000,8000]` | 启动补齐与重试阶梯（空数组=不跑） |
| `debounceMs` / `recheckMs` | `800` / `6h` | 去抖 / 定时复查（0=关闭） |
| `fill.{limits,input,reasoning,name}` | 全 `true` | 分项开关 |
| `force` | `false` | 覆盖已有非空值 |
| `strict` / `mapping` | `false` / `{}` | fail-closed 与显式映射 |
| `providers` / `excludeProviders` | `[]` / `[]` | 只处理 / 完全不碰的渠道 |
| `nameStyle` | `"plain"` | `"vendor"` 写成 `deepseek: DeepSeek V4 Pro` |
| `reasoningProtocols` / `forceReasoning` | `["openai-completions","openai-responses"]` / `false` | 协议守卫 |
| `toggleLevels` | `["off","low","high","max"]` | 纯开关模型的档位 |
| `margin` | `0.85` | 输出上限安全边际 |
| `endpoint` / `cacheTtlMs` / `cacheFile` / `snapshotPath` | models.dev / 24h / `$DSH_HOME/cache/...` / 包内快照 | 目录来源 |
| `timeoutMs` | `20000` | 网络超时 |
| `credentialRef` | `{NAME}_API_KEY` | 凭据引用模板 |

## 测试

```bash
node test/logic.mjs          # 30 项：schema 解析、目录合并、匹配与上限、规划器、探测
node test/integration.mjs    # 10 项：真实 defineTool/apply + 假 settings 服务，覆盖写入/触发/导入两条路径
```

`test/integration.mjs` 需要能解析 `@deepseek-ai/dsh-tools`、`schemastery`、`cordis` 这些 peer 依赖，所以要在装好依赖的环境里跑。

## 与其他同类插件的定位

生态里已有多个"元数据补全"插件（`dsh-model-fix`、`dsh-model-meta-autofill`、`dsh-model-detector`、`dsh-model-auto-enricher`、`dsh-autofill-model-metadata` 等），本插件的差异点是：

1. **会话内接渠道**：`provider_import` 让 Agent 在对话里完成导入，同类插件多数假设你已在设置页加好渠道。
2. **凭据安全**：导入即写凭据库，且优先走 `apiKeyEnv` 引用，密钥可完全不进会话。
3. **双向 `/v1` 探测**：不是启发式拼接，而是真的试两条并回退。
4. **枚举来自运行时 schema**：字段名（`input` vs `inputModalities`）与取值都不写死。
5. **fail-closed 可选**：需要"绝不猜测"时用 `strict` + `mapping`。

## 验证状态

- **逻辑测试**：30 项（schema 解析、目录三层合并、匹配与上限、规划器、`/v1` 探测、凭据解析）。
- **集成测试**：10 项，用真实 `defineTool` / `apply` + 内存 settings 服务，覆盖写入、`modelOverrides`、strict、协议守卫、两条导入路径、三类触发。
- **真机验证**（headless profile，`dsh plugin add` 安装）：插件作为 profile 层加载，并在一次真实启动里通过 `ctx.settings.mutate` 把元数据写进了真实 `cordis.patch.yml`：

  ```yaml
  - id: deepseek-v4-pro
    name: DeepSeek V4 Pro
    contextWindow: 512000
    maxTokens: 325632
    reasoningEfforts:
      off: null
      minimal: minimal
      # … high / xhigh / max
  - id: glm-5.3-flash
    name: GLM-5.3-Flash
    contextWindow: 1000000
    input: [text, image]        # 原生视觉自动勾选
    reasoningEfforts: { … }
  ```

  这次真机测试还抓出一个真 bug：`credentials` 原本是硬依赖，在没有凭据服务的 profile 里会让插件永远 `pending`；现在改为**可选**，只有"内联 key 存储"这一条路径需要它，缺失时给出明确报错。

- **触发链路真机验证**（"导入即自动补全"）：用探针调用 `ctx.settings.update("llm-pi-ai", …)`——设置页保存走的就是这条路——同时把启动补齐与定时复查都关掉（`bootDelays: []`、`recheckMs: 0`），新增的模型行仍然被补全。事件序列：

  ```
  simulating UI save: appending glm-5.3
  event settings/document-updated ns=llm-pi-ai   ← 保存动作本身发出的事件
  update resolved
  event settings/document-updated ns=llm-pi-ai   ← 插件写入后再发一次（下一轮无操作，自动收敛）
  ```

  结果：新增的 `glm-5.3` 行拿到了 `contextWindow: 1000000`、`maxTokens: 110592`、`input: [text, image]` 与推理等级——**唯一可能的来源就是设置事件**。

## 设置页：用 DSH 原生的

插件**不提供自己的界面**，而是把选项交给 DSH 内置的设置页渲染：`Config` 里所有用户选项都标了 `.volatile()`，`dsh-settings` 只为含 volatile 字段的条目生成表单。

这一点也在真实 profile 里验证过——用一个探针插件打印 `ctx.settings.describe()`：

```
total namespaces: 13
model-autofill: form leaves=25
enabled:boolean | namespaces:array | autoFillOnStart:boolean | watchSettings:boolean |
debounceMs:number | bootDelays:array | recheckMs:number | force:boolean | strict:boolean |
mapping:dict | providers:array | excludeProviders:array |
fill.limits:boolean | fill.input:boolean | fill.reasoning:boolean | fill.name:boolean |
nameStyle:union | reasoningProtocols:array | forceReasoning:boolean | toggleLevels:array |
margin:number | endpoint:string | cacheTtlMs:number | timeoutMs:number | credentialRef:string
```

也就是说：内置设置页会为这个插件渲染 **25 个可编辑控件**，并显示当前值；`cacheFile` / `snapshotPath` 这类部署路径按设计不暴露。设置改动写入 profile 的 `cordis.patch.yml`，且因为读的是 volatile 访问器，**改完下一轮就生效，不用重启**。

## 已知限制

- 没有"逐行预览 / 一键全部覆盖"的专用页面（同类里 `dsh-model-meta-autofill` 有）。原生表单能改选项，但逐模型的批量操作仍走工具（`force: true` 或一句"强制覆盖一遍"）。
- 真机验证用的是 **headless** profile；`desktop` profile 由 Electron 独占，未在其中验证。
- 本机 **npm 全局安装的 `dsh` CLI 无法创建 profile 模块兜底链接**（Windows 拒绝 Node 的 symlink 调用），CLI profile 需用应用自带的那份 `dsh`。这是环境问题，与本插件无关。

## License

MIT
