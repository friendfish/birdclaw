# Issue #58：休眠失败后的 Freshness 恢复设计

## 文档状态

- 日期：2026-08-09
- 关联 Issue：[#58](https://github.com/friendfish/birdclaw/issues/58)
- 选定方案：持久化 attempt 生命周期、有限后台退避、页面恢复兜底
- 范围：Today/24h freshness 触发、运行结果回写和页面恢复

## 结论摘要

Today/24h 的 freshness attempt 不再在运行开始前进入永久终态。到期任务取得
调度锁后进入 `running`；批次成功时正常消费并根据新内容安排下一次 freshness，
全量失败时则进入 `retryable` 并保存 `retryAt`。

同一份过期内容最多安排三次后台重试，使用 15 分钟、1 小时和 4 小时的退避。
后台次数耗尽后状态为 `failed`，不再安装 LaunchAgent。用户同日重新打开或恢复
Today 页面时，仍可对这份过期内容发起一次额外恢复尝试。该页面兜底机会持久化
在 attempt state 中，因此刷新、重新挂载或多个进程不能重复消耗它。

跨自然日的 attempt 一律不再运行，由新一天的固定任务接管。

## 用户体验

1. Mac 休眠期间 freshness 任务可以因网络不可用而失败，现有摘要继续显示。
2. Birdclaw 在同一天内以有限次数和逐步拉长的间隔后台重试，不会连续轰炸网络或模型。
3. 用户真正开盖并回到 Today 页面时，如果内容仍过期且没有活动批次，页面会再尝试恢复一次。
4. 同一份旧摘要只拥有一次页面恢复机会；重复聚焦、刷新和多进程请求不会重复启动批次。
5. 当任一来源成功发布后，页面继续沿用现有行为：显示成功的新版本，并按新版本重新计算 freshness。
6. 第二天不会补跑前一天未完成的 attempt。

## 状态模型

继续使用 `PeriodDigestFreshnessStateV1` 的向后兼容 JSON 结构，增加可选字段，避免
现有安装升级时丢弃状态：

```ts
status: "scheduled" | "running" | "retryable" | "failed" |
  "consumed" | "disabled" | "error";
retryCount?: number;
retryAt?: string;
pageRecoveryUsedAt?: string;
completedAt?: string;
```

- `scheduled`：初次 freshness 已安装，等待 `dueAt`。
- `running`：某个进程已原子取得该 token；其他进程只能跳过或加入现有摘要批次。
- `retryable`：上次批次全量失败，已保存并安装下一次 `retryAt`。
- `failed`：三次后台重试均失败，不再自动调度；同日仍可使用一次页面恢复机会。
- `consumed`：成功完成或从旧版本读取的终态。新版成功完成时写入 `completedAt`；
  对于没有该字段的旧版同日 `consumed` 状态，页面可使用一次恢复机会，修复升级前
  已卡住的用户。
- `disabled`：freshness 截止时间或下一次重试跨日。
- `error`：LaunchAgent 安装失败；页面仍可在同日直接恢复，不依赖该 agent。

状态文件继续由现有进程内队列、跨进程 scheduler lease 和原子 rename 保护。
attempt token 仍由 period、freshness 配置和来源版本身份生成；后台重试复用同一个
token，因此并发触发无法绕过状态锁。

## 运行流程

### 初次与后台触发

1. launchd 使用 attempt token 调用 `consumePeriodDigestFreshnessAttempt`。
2. consume 在 scheduler lease 内校验 token、自然日、到期时间和状态，然后将状态写为 `running`。
3. CLI 启动或加入统一的 period digest 批次，并等待 completion。
4. 若批次至少发布一个来源，现有 orchestrator reconciliation 根据新 version identity
   安排下一次 freshness；失败来源继续使用现有 suppression 规则。
5. 若批次全量失败，completion 回写在 scheduler lease 内把同一 token 标为
   `retryable`，计算退避时间并安装一次性 LaunchAgent。
6. 第三次后台重试仍失败后写为 `failed`，不再自动安装任务。

### 页面恢复

页面只在 metadata 显示 `stale + no active run` 时发送 freshness POST。请求遵守与
launchd 相同的 token 和调度锁，但在以下状态拥有恢复语义：

- `retryable` 且已经到达 `retryAt`：可提前于或替代 launchd 取得本次后台重试；
- `failed`：可消耗一次持久化页面恢复机会；
- 旧版 `consumed` 或调度安装 `error`：可消耗一次持久化页面恢复机会。

页面 freshness 去重 key 加入最终 run 的身份/完成时间。这样每次失败批次结束后，
页面能重新评估服务端状态；同一批次的普通轮询仍只发送一次 POST。真正是否允许
启动由持久化 state 和跨进程锁决定，React ref 不是正确性的唯一边界。

### 完成回写

新增一个幂等的 freshness completion 操作，输入包含 period、attempt token、触发
origin 和最终 run phase。只有 state 仍匹配该 token 且处于 `running` 时才允许更新：

- `completed` / `degraded`：若发布 reconciliation 尚未换成新 token，则落为 `consumed`；
- `failed`：按照 retryCount 和 origin 进入 `retryable` 或终态 `failed`；
- token 已变化：说明成功发布已建立下一代 attempt，旧 completion 直接忽略。

页面触发和 CLI launchd 触发都必须把 completion 接回该操作。即使 freshness 请求
加入了一个由 scheduled/manual 触发的活动批次，也能根据该共享批次的最终结果正确
结束自己的 attempt。

## 退避与上限

- 后台重试间隔固定为 15 分钟、1 小时、4 小时，共三次。
- `retryAt` 向上取整到分钟，便于复用当前一次性 LaunchAgent 构造。
- 若 `retryAt` 跨越本地自然日，不安装任务，状态改为 `disabled`。
- 后台次数耗尽后只保留一次页面恢复机会；页面恢复失败不再自动重排。
- 任何尚未到期、正在运行、token 不匹配或跨日的请求都不会启动新批次。

## 错误处理与兼容性

- LaunchAgent 安装失败保留 `error` 和 `installError`，不会伪装成已成功调度。
- completion 回写失败不能改写摘要批次结果，但 CLI 会记录失败，页面后续仍可通过
  状态检查恢复。
- 旧 state 缺少新增字段时按 `retryCount = 0`、页面恢复未使用处理。
- 不修改 current digest 数据格式、生成顺序、每来源模型重试或 period run lock。
- 不建设常驻 worker，也不监听 macOS 的 Wake 通知；页面焦点恢复继续作为用户可见兜底。

## 测试

1. 状态单测：scheduled -> running -> retryable，验证 retryAt、退避、同 token 和原子消费。
2. 上限单测：三次后台重试后进入 failed，不再安装 LaunchAgent。
3. 页面恢复单测：failed/旧 consumed/error 同日只允许一次，跨日拒绝。
4. 并发单测：同 token 的多个进程/请求只有一个取得 running。
5. completion 单测：成功、新 token、安装失败和重复 completion 均幂等。
6. CLI 单测：launchd freshness completion 会回写成功或失败结果。
7. 页面单测：失败 run 更新去重 key，恢复焦点可再次请求，但同一 run 不重复 POST。
8. 集成回归：DarkWake 全量失败 -> retryable -> 同日页面恢复 -> 成功发布 -> 新 freshness 被安排。

## 非目标

- 不保证 Mac 在持续休眠时完成摘要。
- 不改变每个来源内部已有的三次模型调用重试。
- 不为 Yesterday/Week 增加 freshness。
- 不允许跨日恢复前一天的 attempt。
- 不增加用户可配置的 freshness 重试参数。
