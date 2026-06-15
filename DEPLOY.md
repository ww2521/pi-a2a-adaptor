# pi-a2a-adaptor 部署指南

## 部署到 pi

将**整个项目目录**复制到 pi 的扩展目录：

```bash
# 在 pi 主机上执行
mkdir -p ~/.pi/agent/extensions/
# 将整个 pi-a2a-adaptor 目录复制过去
cp -r /path/to/pi-a2a-adaptor ~/.pi/agent/extensions/
```

或者 SCP：

```bash
scp -r /home/ww2521/.openclaw/workspace/pi-a2a-adaptor pi@<pi-host>:~/.pi/agent/extensions/
```

## 最终目录结构

```
~/.pi/agent/extensions/pi-a2a-adaptor/
├── package.json           ← 含 "pi": {"extensions": ["./src/index.ts"]}
├── src/
│   ├── index.ts           ← 导出
│   ├── client.ts          ← A2AClient 核心
│   ├── registry.ts        ← AgentRegistry
│   ├── task-manager.ts    ← TaskManager
│   ├── types.ts           ← 类型定义
│   └── errors.ts          ← 错误类型
└── pi-extension/
    └── index.ts           ← pi 插件入口（命令+工具注册）
```

**不需要编译。** pi 通过 jiti 直接加载 TypeScript。

## package.json 关键字段

```json
{
  "name": "pi-a2a-adaptor",
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

`pi.extensions` 告诉 pi 哪些文件是扩展入口。

## 重启 pi

```bash
pi restart
# 或热重载
/reload
```

## 验证

```
/a2a-help
/a2a-discover <your-agent-url>
/a2a-send <agent-url> "hello"
```

## 排错

```bash
# 查看扩展日志
cat ~/.pi/logs/extensions.log | grep a2a

# 确认目录结构
ls -la ~/.pi/agent/extensions/pi-a2a-adaptor/src/
```
