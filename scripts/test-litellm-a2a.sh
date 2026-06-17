#!/usr/bin/env bash
# test-litellm-a2a.sh — 直接用 curl 测试 LiteLLM A2A endpoint
#
# 用法: ./test-litellm-a2a.sh <litellm-url> <api-key> [agent-name]
# 例如: ./test-litellm-a2a.sh http://192.168.1.100:4000 sk-xxxx tecgo-triage
#
# 用途: 不依赖 pi-a2a-adaptor，直接验证 LiteLLM A2A gateway 是否正常工作

set -euo pipefail

LITELLM_URL="${1:?Usage: $0 <litellm-url> <api-key> [agent-name]}"
API_KEY="${2:?Usage: $0 <litellm-url> <api-key> [agent-name]}"
AGENT_NAME="${3:-}"

echo "═══════════════════════════════════════"
echo " LiteLLM A2A 直连测试"
echo "═══════════════════════════════════════"
echo "LiteLLM URL: $LITELLM_URL"
echo "API Key:     ${API_KEY:0:6}..."
echo ""

# Step 1: 获取 agent 列表
echo "─── Step 1: GET /v1/agents ───"
AGENTS=$(curl -sf -H "Authorization: Bearer $API_KEY" "$LITELLM_URL/v1/agents" 2>&1)
if [ $? -ne 0 ]; then
  echo "❌ 获取 agent 列表失败: $AGENTS"
  exit 1
fi
echo "$AGENTS" | python3 -m json.tool 2>/dev/null || echo "$AGENTS"
echo ""

# 如果没指定 agent name，从列表里取第一个
if [ -z "$AGENT_NAME" ]; then
  AGENT_NAME=$(echo "$AGENTS" | python3 -c "
import sys, json
data = json.load(sys.stdin)
agents = data.get('agents', data)
if agents:
  print(agents[0].get('agent_name', agents[0].get('name', agents[0].get('agent_id'))))
" 2>/dev/null || echo "")
  if [ -n "$AGENT_NAME" ]; then
    echo "自动选择 agent: $AGENT_NAME"
    echo ""
  else
    echo "❌ 无法自动选择 agent，请手动指定: $0 <url> <key> <agent-name>"
    exit 1
  fi
fi

# Step 2: 测试 Agent Card
echo "─── Step 2: GET Agent Card ───"
CARD=$(curl -sf -H "Authorization: Bearer $API_KEY" \
  "$LITELLM_URL/a2a/$AGENT_NAME/.well-known/agent-card.json" 2>&1)
if [ $? -ne 0 ]; then
  echo "❌ Agent Card 获取失败: $CARD"
  exit 1
fi
echo "$CARD" | python3 -m json.tool 2>/dev/null || echo "$CARD"
CARD_URL=$(echo "$CARD" | python3 -c "import sys,json; print(json.load(sys.stdin)['url'])" 2>/dev/null || echo "N/A")
echo "  → agent.url = $CARD_URL"
echo ""

# Step 3: message/send (blocking=false, 异步模式)
echo "─── Step 3: POST message/send (blocking=false) ───"
echo "发送: hello"
SEND_RESP=$(curl -sf --connect-timeout 20 --max-time 30 -X POST \
  "$LITELLM_URL/a2a/$AGENT_NAME" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "message/send",
    "params": {
      "message": {
        "role": "user",
        "parts": [{"kind": "text", "text": "hello"}],
        "messageId": "curl-test-1"
      },
      "configuration": {
        "acceptedOutputModes": ["text/plain", "application/json"],
        "blocking": false
      }
    }
  }' 2>&1)
echo "$SEND_RESP" | python3 -m json.tool 2>/dev/null || echo "$SEND_RESP"

# 提取 task ID
TASK_ID=$(echo "$SEND_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d.get('result', {})
print(r.get('id', ''))
" 2>/dev/null || echo "")

TASK_STATE=$(echo "$SEND_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d.get('result', {})
s = r.get('status', {})
print(s.get('state', 'N/A'))
" 2>/dev/null || echo "N/A")

echo ""
echo "  → taskId: ${TASK_ID:-NONE}"
echo "  → state: $TASK_STATE"
echo ""

# 判断结果类型
if [ -z "$TASK_ID" ]; then
  echo "⚠️  返回的是直接消息（同步完成），不是异步 task"
  echo "   这在 agent 处理很快时正常。"
  echo ""
  echo "═══ 结果: 同步模式 OK ═══"
  exit 0
fi

# Step 4: tasks/get (轮询)
if [ "$TASK_STATE" != "completed" ] && [ "$TASK_STATE" != "failed" ] && [ "$TASK_STATE" != "canceled" ] && [ "$TASK_STATE" != "rejected" ]; then
  echo "─── Step 4: POST tasks/get (轮询) ───"
  echo "等待 3 秒后轮询..."
  sleep 3

  TASK_RESP=$(curl -sf --connect-timeout 20 --max-time 30 -X POST \
    "$LITELLM_URL/a2a/$AGENT_NAME" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $API_KEY" \
    -d "{
      \"jsonrpc\": \"2.0\",
      \"id\": 2,
      \"method\": \"tasks/get\",
      \"params\": {\"id\": \"$TASK_ID\"}
    }" 2>&1)
  echo "$TASK_RESP" | python3 -m json.tool 2>/dev/null || echo "$TASK_RESP"

  FINAL_STATE=$(echo "$TASK_RESP" | python3 -c "
import sys, json
d = json.load(sys.stdin)
r = d.get('result', {})
s = r.get('status', {})
print(s.get('state', 'N/A'))
" 2>/dev/null || echo "ERROR")

  echo ""
  echo "  → final state: $FINAL_STATE"
  echo ""

  if [ "$FINAL_STATE" = "ERROR" ]; then
    echo "❌ tasks/get 请求失败"
    echo "═══ 结果: 轮询失败 ═══"
    exit 1
  fi
fi

echo "═══ 结果: A2A 异步模式 OK ═══"
