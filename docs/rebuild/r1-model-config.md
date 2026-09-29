# R1：Pi 模型插件设计草案

状态：供讨论，未批准实施。2026-09-29。

本文替代此前单连接设计。此前 `ai-config` 等未提交实现仅为中止的尝试，不作为本方案基础。本轮仅更新设计文档，不修改功能代码。R4 暂缓，PR #75 保持草稿。

## 1. 用户目标

- 多厂商、多连接、多模型；同一厂商可建立多个独立连接。
- 页面配置与文件配置一致，页面是配置编辑器，不另存一套模型状态。
- 优先采用 Pi coding agent 的设计与实现，减少自维护协议代码。
- 以插件边界接入 Birdclaw，控制未来同步上游的冲突面。

## 2. 已核对的参考与边界

Birdclaw 基线：`5a778ef968030ef110c31d32813b84d187ebf47e`。
Pi 仓库当前为 `earendil-works/pi`；本次读取 main 的模型文档、AI 包及 coding-agent 核心文件，并记录查询到的 main SHA `5257d0d5f3ab7d42550804f32c67a77b49f485d4` 作为后续复核锚点。网页读取与 SHA 查询并非原子操作，正式抽取前需在该 SHA 再核对来源。

AI 包源码 manifest 显示名称 `@earendil-works/pi-ai`、版本 `0.87.1`，提供 provider/API 子路径导出，声明 Node >=22.19.0。这是源码观察，不代表已验证 npm 发布物或 Birdclaw 的 Bun/Node 运行兼容性。正式采用版本以锁定发布物和兼容性验证为准。

Pi 的 ModelRegistry 是 ModelRuntime 的外观；后者依赖配置、凭据、目录缓存、provider composition、virtual models 等多个模块。因此不能只复制 ModelRegistry，也不应把整个 coding-agent/TUI 拉入 Birdclaw。

参考：
- https://github.com/earendil-works/pi/blob/main/packages/ai/package.json
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/models.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-registry.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-runtime.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/model-config.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/provider-composer.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/auth-storage.ts
- https://github.com/earendil-works/pi/blob/main/packages/ai/src/providers/all.ts

## 3. 复用决策

| 能力 | 方案 |
| --- | --- |
| 提供商协议、流式事件、完成结果、取消、用量 | 直接依赖固定版本 Pi AI 公共 API，不复制协议实现 |
| 内置厂商与模型目录 | 复用 Pi provider factories/catalog；按需要导入，刷新显式触发 |
| models.json 结构、模型覆盖与兼容参数 | 沿用 Pi 语义；抽取必要的配置解析/组合代码并保留来源 |
| auth.json 与 CredentialStore | 实现 Pi 公共凭据存储接口，参考其文件存储、锁及重载机制 |
| 功能分配、Web UI、业务缓存 | Birdclaw 插件/宿主实现，不复制 coding-agent 的会话与终端交互 |
| OAuth、虚拟路由、远端目录后台更新、工具执行 | 首版不启用，不因依赖 Pi 自动成为产品承诺 |

抽取文件集中放在 vendor/pi 下，记录源 SHA、文件路径、许可证和修改清单，保留 MIT 通知。优先完整保留可独立单元，用外围适配改变行为；必须修改源文件时，保留可比较补丁。不得深度导入 coding-agent 未公开的包内部路径。

## 4. 插件结构与依赖方向

首版为仓库内静态注册插件，独立目录与接口；不建设通用插件市场。暂不为模块化改造整个仓库为 monorepo。

```text
src/model-contract/              # 无 Pi、React、Effect、数据库依赖的契约
src/plugins/pi-models/
  public.ts                     # 服务端唯一公开入口
  runtime/                      # Pi Models/provider 与事件适配
  configuration/                # 配置快照、校验、迁移、功能绑定
  credentials/                  # CredentialStore 实现
  vendor/pi/                    # 有来源记录的必要抽取代码
  ui/                           # 浏览器配置页，只依赖公开 DTO
  tests/
src/integrations/models/         # Birdclaw 宿主桥接，Effect/结果解析/缓存映射
src/routes/                     # 薄页面与 HTTP handler，复用上游鉴权
```

依赖方向：业务 -> 宿主桥接 -> 契约 <- Pi 插件 -> Pi AI。只在启动/装配模块引用具体插件。插件不得反向 import 上游业务模块、数据库、摘要或搜索实现；依赖通过初始化参数注入。浏览器入口不能引入文件系统、凭据库、Pi 服务端 SDK。

模型服务接口（概念性，不是实现承诺）：
- listModels：返回脱敏模型目录、能力和可用性原因。
- resolve：输入模型引用/功能/运行覆盖，得到无密钥的模型说明与运行身份。
- generate：输入系统提示词、消息、参数和 AbortSignal，返回统一异步事件流。
- refresh：显式刷新配置或模型目录。
- dispose：释放插件持有资源。

管理服务独立提供配置读取/更新、连接测试、模型发现、凭据替换/删除；不把管理操作塞进生成接口。HTTP/React/Effect 均不出现在契约内。

统一事件：start、text-delta、usage、done、error。done 区分 completed、length、aborted 等终止原因；宿主决定哪些能发布为成功结果。Pi 原始事件与类型仅在插件内部使用。首版不发送工具定义；意外 tool-call 不能被当成普通文本成功。

## 5. 提供商与模型身份

连接实例 ID 是稳定内部标识，例如 openai-personal、openai-work；厂商品牌与连接 ID 分开。每个连接拥有独立地址、认证、模型列表及兼容配置。

模型引用为结构化 `{ provider: connectionId, model: modelId }`，不以斜杠拆分；模型 ID 本身可能包含斜杠。

内置厂商创建第二个连接时，不能假定所有 Pi factory 都支持重命名。兼容性验证必须确认 factory/组合方式能绑定独立 ID 和独立 CredentialStore 命名空间；否则使用公共 createProvider/协议 API 包装，在插件内处理。不得把一个连接的失败认证回退到另一个连接。

## 6. 首批厂商矩阵

本表是交付目标和已有源码依据，不是已完成连接验证。

| 页面模板 | 已观察到的 Pi 基础 | 首版计划 |
| --- | --- | --- |
| OpenAI | openai provider | API Key；Responses 与可明确选择的 Chat Completions |
| Anthropic | anthropic provider | API Key；原生 Messages |
| Google Gemini | google provider | API Key；原生 Google 协议 |
| DeepSeek | deepseek provider | API Key；采用 Pi 对应适配 |
| OpenRouter | openrouter provider | API Key；模型目录与对应适配 |
| Moonshot/Kimi | moonshotai、moonshotai-cn、kimi-coding | 普通 API 与 Coding 服务分别展示；优先普通 API |
| 智谱 | zai、zai-coding-cn | 按地区/服务分别建模板，不把普通 API 与 Coding 套餐等同 |
| MiniMax | minimax、minimax-cn | 按地区分别建模板；沿用具体 Pi 协议 |
| 通义千问 | qwen-token-plan 系列已存在 | Coding/Token Plan 独立模板；普通百炼接口另行核验并作为兼容连接接入，不能冒充同一服务 |
| Ollama、LM Studio、自定义 | Pi 兼容协议机制 | 手工地址、可选无认证、手工模型；动态发现按端点能力启用 |

同厂商不同服务必须分别核对地址、认证与协议。验收区分目录存在、模拟调用通过、真实连接通过，不将其中任一项替代另一项。真实调用由用户提供相应可用连接后另行验证。

## 7. 配置布局与优先级

建议统一放在 `$BIRDCLAW_HOME/ai/`：
- models.json：Pi 风格的 providers/models/modelOverrides 与兼容参数。
- auth.json：按连接 ID 存储凭据，保持 Pi CredentialStore 可适配结构。
- settings.json：Birdclaw 专属 schemaVersion、全局默认、功能分配、界面显示/启用元数据。
- catalog-cache.json：可重建模型发现缓存，不与人工配置混写。

页面与文件是同一数据源。UI 保留未编辑的兼容字段；修改使用 revision 比较，拒绝覆盖过期页面。写入原子发布；跨文件操作先保存可独立存在的连接/凭据，最后更新引用；删除先检查并移除绑定，再清理凭据。需要事务式批量导入时，使用独立迁移协议，不假装多个 rename 是一个事务。

模型选择：单次明确选择 > 功能绑定 > 全局默认。参数：单次覆盖 > 功能参数 > 模型默认 > 应用默认。输出预算不得超过已知模型上限；未知上限需明确显示，不能猜测能力。

认证使用显式来源：保存密钥、指定环境变量、无认证。沿用 Pi 的认证存储结构，但不开放 models.json 的 !command 执行能力。旧 OPENAI_* / BIRDCLAW_* 变量只通过 legacy 连接兼容，不全局覆盖其他连接。兼容范围文档明确，不宣称与 Pi 配置 100% 等价。

## 8. 用户流程

配置页三个页签：提供商、模型、功能分配。

添加连接 -> 选择厂商/具体服务 -> 地址与认证 -> 选择目录模型或手工添加 -> 测试模型 -> 设为默认/分配功能。

连接列表可显示已配置但未验证、已验证、配置错误、被停用等状态；不以有密钥等同可用。模型发现默认使用随包目录，远程获取由用户触发，不默认认为每个厂商都有 /models。

模型列表区分内置、发现、自定义；远端列表变化不覆盖用户编辑，不自动删除或重分配。启用/删除操作检查引用，删除默认模型需要先选择替代项。

模型选择器统一显示模型名称和连接名称；参数表单按模型能力展示。单次选择不修改定时任务。功能分配覆盖摘要、人物分析、讨论、收件箱评分，均可继承全局默认。

## 9. Birdclaw 接入清单

1. analysis-runtime：调用中立模型服务，保留现有 Markdown/JSON 业务解析，不伪造 Responses SSE 来适配 Pi。
2. analysis-report：启动时固定选择、参数和配置版本；返回、保存与缓存使用同一个运行身份。
3. openai.ts 的 inbox 独立路径：迁入相同服务，JSON 评分提示和校验仍归业务。
4. analysisReportCacheKey 与 period-digest latest key：增加连接、模型、生成配置身份，密钥不进入缓存键。旧结果保留可读，新请求不冒用旧缓存。
5. 三个分析 API：移除只允许 gpt-5.5 的白名单，改为校验完整模型引用与可用性；旧 model 参数定义明确兼容规则。
6. 页面/API/CLI 装配：薄路由、导航、配置页、模型选项；遵循上游认证、只读限制和取消机制。
7. package/build：加入固定 Pi 依赖，验证 Vite 服务端、CLI 外置依赖、npm 包完整性与 Node/Bun；不把服务端模块打入客户端。

这些是接入类别，不承诺只改三个文件。业务入口只传功能标识/模型引用，不散落 provider 判断；通过依赖边界检查防止未来回流耦合。

配置更新构建新快照并验证后激活，失败保持上一个明确标识的有效快照并报告未生效；启动时无有效快照则拒绝 AI 调用。运行中的请求保持原快照，新请求读取新版本。身份包括模型连接与生成参数的非敏感版本，避免中途变更导致结果错标。

## 10. 实施前兼容性验证

以下是待执行门禁，不在本次讨论中宣称完成：
- 锁定 Pi 发布物，并在固定 Bun 与 Node26 下验证。
- 四类协议使用受控响应验证增量、完整结果、usage、取消、错误及截断。
- 同厂商两个连接使用同名模型，验证认证、地址、缓存和配置均隔离。
- 自定义无认证连接、手工模型、未知能力、无 /models 接口可正常管理。
- 固定输出预算能传到真实请求参数，不被 Pi 的归一化静默改变；默认推理参数不损失上游约定。
- 验证完整 npm 发布物和浏览器/服务端代码边界。

实施顺序：兼容性验证 -> 插件配置/目录/认证 -> 宿主统一调用 -> 配置 UI/模型选择 -> 旧配置迁移及完整验收。每步独立 PR，R4 不作为依赖。

## 11. 验收与不纳入项

必须通过：模型与环境优先级、持久化重载、配置冲突、错误不泄密、只读限制、流式/完整输出、取消与终止、参数和预算、缓存隔离、四个业务入口、Playwright 配置与选择、Node/Bun 与发布物。

旧 fork 单组 ai 配置转换为 legacy 连接和默认模型，先预览备份再迁移；不读取或修改用户 Pi 的 ~/.pi/agent 配置。历史数据和结果不删除；R1 不升级业务数据库。恢复文档同时说明旧 config.json 与新增 ai 目录，代码回退不自动撤销配置迁移。

首版不建设插件市场，不提供自动跨提供商回退/负载均衡，不开放配置中的任意命令执行，不承诺 OAuth 订阅登录、图像生成或 Agent 工具循环。
