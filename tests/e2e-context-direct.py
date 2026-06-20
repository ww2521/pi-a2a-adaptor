#!/usr/bin/env python3
"""
E2E test: Conversation context reuse — direct to fasta2a (no bridge)
"""

import json
import time
import urllib.request

AGENT_URL = "http://localhost:18080"

def a2a_post(data: dict, url: str = AGENT_URL) -> dict:
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())

_id_counter = 0

def send_message(text: str, context_id: str = None) -> dict:
    global _id_counter
    _id_counter += 1
    msg = {
        "kind": "message", "role": "user",
        "parts": [{"kind": "text", "text": text}],
        "messageId": f"msg-{_id_counter}",
    }
    if context_id:
        msg["contextId"] = context_id
    return a2a_post({
        "jsonrpc": "2.0", "id": _id_counter,
        "method": "message/send",
        "params": {
            "message": msg,
            "configuration": {
                "acceptedOutputModes": ["text/plain", "application/json"],
                "blocking": False,
            },
        },
    })

def get_task(task_id: str) -> dict:
    global _id_counter
    _id_counter += 1
    return a2a_post({
        "jsonrpc": "2.0", "id": _id_counter,
        "method": "tasks/get",
        "params": {"id": task_id},
    })

def extract(result, key):
    """Extract from {result: {task: {key}}} or {result: {key}}"""
    r = result.get("result", result)
    if "task" in r:
        return r["task"].get(key, "")
    return r.get(key, "")

def wait_task(task_id: str, max_wait=15) -> dict:
    for _ in range(max_wait):
        task = get_task(task_id).get("result", {})
        state = task.get("status", {}).get("state", "")
        if state in ("completed", "failed", "canceled", "rejected"):
            return task
        time.sleep(1)
    return get_task(task_id).get("result", {})

def response_text(task):
    # From artifacts
    for a in task.get("artifacts", []):
        for p in a.get("parts", []):
            if p.get("kind") == "text" and p.get("text"):
                return p["text"]
    # From history
    for m in reversed(task.get("history", [])):
        if m.get("role") == "agent":
            for p in m.get("parts", []):
                if p.get("kind") == "text" and p.get("text"):
                    return p["text"]
    return f"(state={task.get('status', {}).get('state', '?')})"

print("=" * 60)
print("E2E: Conversation Context Reuse (direct → fasta2a echo agent)")
print("=" * 60)

# ─── Round 1: New context ───
print("\n[Round 1] 'hello, this is the first message'")
r1 = send_message("hello, this is the first message")
t1 = extract(r1, "id")
c1 = extract(r1, "contextId")
print(f"  task={t1[:8]}...  ctx={c1[:8]}...")
task1 = wait_task(t1)
print(f"  response: {response_text(task1)}")

# ─── Round 2: Same context ───
print(f"\n[Round 2] 'second message' (reuse ctx={c1[:8]}...)")
r2 = send_message("second message", context_id=c1)
t2 = extract(r2, "id")
c2 = extract(r2, "contextId")
assert c2 == c1, f"FAIL: ctx mismatch {c2} != {c1}"
print(f"  ✅ contextId preserved!")
task2 = wait_task(t2)
print(f"  response: {response_text(task2)}")
print(f"  history length: {len(task2.get('history', []))} messages")

# ─── Round 3: Same context ───
print(f"\n[Round 3] 'what did I say?' (reuse ctx={c1[:8]}...)")
r3 = send_message("what did I say?", context_id=c1)
t3 = extract(r3, "id")
c3 = extract(r3, "contextId")
assert c3 == c1, f"FAIL: ctx mismatch {c3} != {c1}"
print(f"  ✅ contextId still preserved!")
task3 = wait_task(t3)
print(f"  response: {response_text(task3)}")
print(f"  history length: {len(task3.get('history', []))} messages")

# ─── Round 4: New context ───
print("\n[Round 4] 'fresh start' (new)")
r4 = send_message("fresh start")
t4 = extract(r4, "id")
c4 = extract(r4, "contextId")
assert c4 != c1, f"FAIL: should be new ctx"
print(f"  ✅ new contextId: {c4[:8]}...")
task4 = wait_task(t4)
print(f"  response: {response_text(task4)}")
print(f"  history length: {len(task4.get('history', []))} messages")

print("\n" + "=" * 60)
print("All tests passed! ✅")
print(f"  ctx1={c1[:8]} (3 rounds)")
print(f"  ctx4={c4[:8]} (new)")
