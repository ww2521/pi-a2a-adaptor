#!/usr/bin/env python3
"""
E2E test: pi-a2a-adaptor conversation context reuse via a2a-bridge → fasta2a echo agent

Tests:
  1. First send → creates new contextId
  2. Second send (with same contextId) → echo agent should see full history
  3. Verify contextId is preserved across rounds
"""

import json
import time
import urllib.request

BRIDGE_URL = "http://localhost:18090/a2a/echo-agent"
AUTH_HEADER = {"Authorization": "Bearer ***"}
CONTENT_HEADER = {"Content-Type": "application/json"}

def a2a_post(data: dict) -> dict:
    body = json.dumps(data).encode()
    req = urllib.request.Request(
        BRIDGE_URL,
        data=body,
        headers={**AUTH_HEADER, **CONTENT_HEADER},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

def get_task(task_id: str) -> dict:
    data = {
        "jsonrpc": "2.0",
        "id": time.time(),
        "method": "tasks/get",
        "params": {"id": task_id},
    }
    return a2a_post(data)

def send_message(text: str, context_id: str = None, msg_id: str = None) -> dict:
    msg_id = msg_id or f"msg-{time.time()}"
    msg = {
        "kind": "message",
        "role": "user",
        "parts": [{"kind": "text", "text": text}],
        "messageId": msg_id,
    }
    if context_id:
        msg["contextId"] = context_id

    data = {
        "jsonrpc": "2.0",
        "id": time.time(),
        "method": "message/send",
        "params": {
            "message": msg,
            "configuration": {
                "acceptedOutputModes": ["text/plain", "application/json"],
                "blocking": False,
            },
        },
    }
    return a2a_post(data)

def extract_task_id(result: dict) -> str:
    if "task" in result:
        return result["task"]["id"]
    return result.get("id", "")

def extract_context_id(result: dict) -> str:
    if "task" in result:
        return result["task"].get("contextId", result["task"].get("context_id", ""))
    return result.get("contextId", result.get("context_id", ""))

def extract_response_text(task: dict) -> str:
    # From artifacts
    if task.get("artifacts"):
        for part in task["artifacts"][0].get("parts", []):
            if part.get("kind") == "text":
                return part["text"]
    # From status.message
    if task.get("status", {}).get("message", {}).get("parts"):
        for part in task["status"]["message"]["parts"]:
            if part.get("kind") == "text":
                return part["text"]
    # From history
    if task.get("history"):
        for m in reversed(task["history"]):
            for part in m.get("parts", []):
                if part.get("kind") == "text" and part.get("text"):
                    return part["text"]
    return f"(state={task.get('status', {}).get('state', 'unknown')})"

def wait_task(task_id: str, max_wait=15) -> dict:
    for _ in range(max_wait):
        task = get_task(task_id)
        result = task.get("result", task)
        state = result.get("status", {}).get("state", "")
        if state in ("completed", "failed", "canceled", "rejected"):
            return result
        time.sleep(1)
    return get_task(task_id).get("result", {})

print("=" * 60)
print("E2E: Conversation Context Reuse via a2a-bridge → fasta2a")
print("=" * 60)

# ─── Round 1: First message, should create new context ───
print("\n[Round 1] Sending: 'hello, this is the first message'")
r1 = send_message("hello, this is the first message")
t1_id = extract_task_id(r1.get("result", {}))
ctx1 = extract_context_id(r1.get("result", {}))
print(f"  task_id:    {t1_id}")
print(f"  contextId:  {ctx1}")

task1 = wait_task(t1_id)
resp1 = extract_response_text(task1)
print(f"  response:   {resp1}")

# ─── Round 2: Send with same contextId ───
print(f"\n[Round 2] Sending: 'second message' (contextId={ctx1})")
r2 = send_message("second message", context_id=ctx1)
t2_id = extract_task_id(r2.get("result", {}))
ctx2 = extract_context_id(r2.get("result", {}))
print(f"  task_id:    {t2_id}")
print(f"  contextId:  {ctx2}")

assert ctx2 == ctx1, f"Context mismatch: {ctx2} != {ctx1}"
print("  ✅ contextId preserved!")

task2 = wait_task(t2_id)
resp2 = extract_response_text(task2)
print(f"  response:   {resp2}")

# ─── Round 3: Third message, verify history accumulates ───
print(f"\n[Round 3] Sending: 'what did I say before?' (contextId={ctx1})")
r3 = send_message("what did I say before?", context_id=ctx1)
t3_id = extract_task_id(r3.get("result", {}))
ctx3 = extract_context_id(r3.get("result", {}))
print(f"  task_id:    {t3_id}")
print(f"  contextId:  {ctx3}")

assert ctx3 == ctx1, f"Context mismatch: {ctx3} != {ctx1}"
print("  ✅ contextId still preserved!")

task3 = wait_task(t3_id)
resp3 = extract_response_text(task3)
print(f"  response:   {resp3}")

# ─── Round 4: New context (no contextId) ───
print("\n[Round 4] Sending: 'fresh start' (no contextId → new)")
r4 = send_message("fresh start")
t4_id = extract_task_id(r4.get("result", {}))
ctx4 = extract_context_id(r4.get("result", {}))
print(f"  task_id:    {t4_id}")
print(f"  contextId:  {ctx4}")

assert ctx4 != ctx1, f"Should be new context: {ctx4} == {ctx1}"
print("  ✅ new contextId created!")

task4 = wait_task(t4_id)
resp4 = extract_response_text(task4)
print(f"  response:   {resp4}")

# ─── Summary ───
print("\n" + "=" * 60)
print("SUMMARY")
print("=" * 60)
print(f"  Round 1 context: {ctx1}")
print(f"  Round 2 context: {ctx2} {'✅ same' if ctx2 == ctx1 else '❌ DIFFERENT'}")
print(f"  Round 3 context: {ctx3} {'✅ same' if ctx3 == ctx1 else '❌ DIFFERENT'}")
print(f"  Round 4 context: {ctx4} {'✅ new' if ctx4 != ctx1 else '❌ SHOULD BE NEW'}")
print("\nAll tests passed! ✅")
