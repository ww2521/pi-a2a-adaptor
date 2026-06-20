# pi-a2a-adaptor 多轮对话上下文管理 — 设计文档

> 2026-06-20

## 1. 背景

pi-a2a-adaptor 作为 pi-coding-agent 的 A2A 扩展，当前每次发送任务都生成全新的 contextId 和 messageId，下游 A2A agent 无法看到历史对话上下文。本设计引入 **Per-agent 对话上下文管理**，使同一 agent 的多轮交互自动复用 contextId，实现自然的多轮对话体验。

## 2. 作用域

| 维度 | 规则 |
|------|------|
| Agent 维度 | 每个 agent URL 独立维护一个 contextId |
| Session 维度 | 不跨 pi session 互通，各自独立管理 |
| Sync/Async | contextId 属于 agent 对话上下文，不区分调用方式 |

## 3. 命令表

| 命令 | 行为 |
|------|------|
| `/a2a-send <agent> <msg>` | 有 contextId 且 < 24h → 复用；无或超期 → 新建 |
| `/a2a-send-async <agent> <msg>` | 同上，但异步提交 |
| `/a2a-new <agent> <msg>` | 强制新建 contextId |
| `/a2a-reset <agent>` | 清除该 agent 的全部记录 |
| `/a2a-conversations` | 查看当前 session 各 agent 的对话状态 |

## 4. 判定逻辑

```
提交请求到达（send / send-async / new）
  ↓
该 agent 有 pending async？
  ├─ 有 → 拒绝，提示 "Agent 正在执行 task-xxx，请稍后重试"
  └─ 无 ↓

是否是 /a2a-new？
  ├─ 是 → 新建 contextId
  └─ 否 ↓

有 contextId 记录 && 最后活动 < 24h？
  ├─ 是 → 复用 contextId
  └─ 否 → 新建 contextId
```

## 5. 数据结构

```typescript
interface ConversationEntry {
  contextId: string;
  topic: string;             // 首条消息前 50 字
  lastMessageAt: number;
  pendingAsyncTasks: string[];
}

// conversations.json — 单 session 持久化
{
  "http://agent-a:8000": {
    "contextId": "ctx-abc123",
    "topic": "给我讲个笑话",
    "lastMessageAt": 1718870400000,
    "pendingAsyncTasks": ["task-abc"]
  }
}
```

持久化路径：`~/.pi/agent/a2a/conversations.json`

## 6. 用户可见反馈

不暴露内部 ID，只显示 `[对话 #N]` 编号。

```
/a2a-send-async weather "讲个笑话"
→ Task submitted: abc123 → weather-agent

/a2a-send-async weather "解释一下"
→ ✗ Agent 正在执行异步任务 (abc123)，请稍后重试

--- task-abc123 完成 ---
→ [A2A weather] Task abc123 completed: "从前有个程序员……"

/a2a-send-async weather "解释一下"
→ Task submitted: def456 → weather-agent [对话 #1]

/a2a-send weather "换个城市"
→ "上海今天晴，25°C" [对话 #1]

--- 24h 后 ---

/a2a-send weather "你好"
→ "你好，有什么可以帮你？" [对话 #2]

/a2a-conversations
weather-agent (http://weather:8000):
  [对话 #2] 你好 - 活跃 - 刚刚

/a2a-reset weather-agent
→ 已清除 weather-agent 的对话上下文
```

## 7. 代码改动

| 文件 | 改动 |
|------|------|
| `types.ts` | TaskOptions 加 `contextId?: string` |
| `task-manager.ts` | sendTask 将 contextId 透传到 Message |
| `client.ts` | 不动 — 已有 `if (!message.contextId) this.generateId()` |
| `index.ts` | 新增 3 个命令；改造 send/send-async 复用逻辑；持久化；tool 支持 |

## 8. 边界处理

- **async 任务完成**：从 pendingAsyncTasks 移除 taskId，contextId 保持
- **async 任务失败/取消**：移除 taskId，contextId 保持（用户可 /a2a-reset 清理）
- **24h 超时**：自动新建 contextId，旧记录标记为 completed
- **/a2a-new**：强制新建，替换旧记录
- **/a2a-reset**：清除记录，pendingAsyncTasks 清空
