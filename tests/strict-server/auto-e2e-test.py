#!/usr/bin/env python3
"""
auto-e2e-test.py — Schema-strict server + TypeScript client e2e test.

Phase 1: Schema validation — verifies the strict server rejects invalid requests
Phase 2: TypeScript client integration — runs vitest against the strict server

Usage: python tests/strict-server/auto-e2e-test.py
Requires: Python 3.12+ with pydantic, starlette, uvicorn; Node.js with vitest
"""
import subprocess
import sys
import time
import json
import urllib.request
import os
import signal
import re
import shutil

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
CLIENT_DIR = os.environ.get("A2A_CLIENT_DIR", os.path.abspath(os.path.join(SCRIPT_DIR, "..", "..")))
STRICT_SERVER = os.path.join(SCRIPT_DIR, "strict_server.py")
SERVER_URL = "http://127.0.0.1:9995"
PASS, FAIL = "✅", "❌"
results = []
server_proc = None

def log(num, name, ok, detail=""):
    s = PASS if ok else FAIL
    results.append((num, name, ok, detail))
    print(f"  {s} [{num:02d}] {name}")
    if detail and not ok:
        print(f"        {detail}")

def post(data, timeout=10):
    req = urllib.request.Request(
        SERVER_URL + "/",
        data=json.dumps(data).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read())

def get(url):
    with urllib.request.urlopen(url, timeout=5) as r:
        return json.loads(r.read())

def find_python():
    """Find a python with pydantic installed"""
    candidates = []
    # Check shared venv at /tmp/a2a-test
    shared_venv = os.path.join(os.path.expanduser("~"), "..", "..", "tmp", "a2a-test", ".venv", "bin", "python")
    if os.path.exists(shared_venv):
        candidates.append(os.path.abspath(shared_venv))
    # Check venv in test dir
    venv_py = os.path.join(SCRIPT_DIR, ".venv", "bin", "python")
    if os.path.exists(venv_py):
        candidates.append(venv_py)
    # Check system
    candidates.append(sys.executable)
    for py in candidates:
        try:
            subprocess.run([py, "-c", "import pydantic; import starlette; import uvicorn"],
                         capture_output=True, check=True)
            return py
        except (subprocess.CalledProcessError, FileNotFoundError):
            continue
    return None

def install_deps(python_exe):
    """Install required deps if missing"""
    venv_dir = os.path.join(SCRIPT_DIR, ".venv")
    if not os.path.exists(os.path.join(venv_dir, "bin", "python")):
        print("  Creating venv...")
        subprocess.run([python_exe, "-m", "venv", venv_dir], check=True)
    py = os.path.join(venv_dir, "bin", "python")
    subprocess.run([py, "-m", "pip", "install", "--quiet",
                    "pydantic", "starlette", "uvicorn"], check=True)
    return py

def start_server(python_exe):
    global server_proc
    env = os.environ.copy()
    # Add venv to PATH so imports work
    venv_bin = os.path.join(SCRIPT_DIR, ".venv", "bin")
    env["PATH"] = venv_bin + ":" + env.get("PATH", "")
    server_proc = subprocess.Popen(
        [python_exe, STRICT_SERVER],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    for _ in range(30):
        try:
            get(f"{SERVER_URL}/.well-known/agent-card.json")
            print(f"  Strict server ready on port 9995")
            return True
        except Exception:
            time.sleep(0.3)
    print(f"  ❌ Server failed to start")
    if server_proc.poll() is not None:
        stderr = server_proc.stderr.read().decode()
        print(f"  stderr: {stderr[-500:]}")
    return False

def stop_server():
    global server_proc
    if server_proc:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()

# ─── Phase 1: Schema Validation ───

def test_schema_validation():
    print("\n▸ Phase 1: Schema Validation (pydantic strict server)")

    # 1. Missing message.kind → reject
    r = post({"jsonrpc":"2.0","id":"sv1","method":"message/send","params":{
        "message": {"role":"user","parts":[{"kind":"text","text":"test"}],"messageId":"m1"},
        "configuration":{"acceptedOutputModes":["text/plain"]},
    }})
    log(1, "Rejects message without kind", r.get("error") is not None,
        f"Got: {json.dumps(r)[:150]}")

    # 2. Wrong kind → reject
    r = post({"jsonrpc":"2.0","id":"sv2","method":"message/send","params":{
        "message":{"kind":"wrong","role":"user","parts":[{"kind":"text","text":"test"}],"messageId":"m2"},
        "configuration":{"acceptedOutputModes":["text/plain"]},
    }})
    log(2, "Rejects wrong kind value", r.get("error") is not None)

    # 3. Missing acceptedOutputModes → reject
    r = post({"jsonrpc":"2.0","id":"sv3","method":"message/send","params":{
        "message":{"kind":"message","role":"user","parts":[{"kind":"text","text":"test"}],"messageId":"m3"},
        "configuration":{"blocking":False},
    }})
    log(3, "Rejects config without acceptedOutputModes", r.get("error") is not None,
        f"Got: {json.dumps(r)[:150]}")

    # 4. Valid request → success
    r = post({"jsonrpc":"2.0","id":"sv4","method":"message/send","params":{
        "message":{"kind":"message","role":"user","parts":[{"kind":"text","text":"hello"}],"messageId":"m4"},
        "configuration":{"acceptedOutputModes":["text/plain"]},
    }})
    log(4, "Valid request (kind:'message') succeeds", "task" in r.get("result", {}),
        f"State: {r.get('result',{}).get('task',{}).get('status',{}).get('state','?')}")

    # 5. File part → success
    r = post({"jsonrpc":"2.0","id":"sv5","method":"message/send","params":{
        "message":{"kind":"message","role":"user","parts":[{"kind":"file","file":{"bytes":"aGVsbG8="}}],"messageId":"m5"},
        "configuration":{"acceptedOutputModes":["text/plain"]},
    }})
    log(5, "Valid file part succeeds", "task" in r.get("result", {}))

    # 6. Data part → success
    r = post({"jsonrpc":"2.0","id":"sv6","method":"message/send","params":{
        "message":{"kind":"message","role":"user","parts":[{"kind":"data","data":{"k":"v"}}],"messageId":"m6"},
        "configuration":{"acceptedOutputModes":["text/plain"]},
    }})
    log(6, "Valid data part succeeds", "task" in r.get("result", {}))

# ─── Phase 2: TypeScript Client Integration ───

def test_ts_client():
    print("\n▸ Phase 2: TypeScript Client vs Strict Server")
    os.chdir(CLIENT_DIR)

    test_file = os.path.join(CLIENT_DIR, "tests", "a2a-client.test.ts")
    with open(test_file) as f:
        original = f.read()

    modified = re.sub(
        r'const BASE_URL = "http://127\.0\.0\.1:\d+"',
        f'const BASE_URL = "{SERVER_URL}"',
        original
    )
    with open(test_file, "w") as f:
        f.write(modified)

    try:
        result = subprocess.run(
            ["npx", "vitest", "run", "--reporter=verbose"],
            capture_output=True, text=True, timeout=120
        )
        output = result.stdout + result.stderr

        # Parse summary
        match = re.search(r'(\d+)\s+passed.*?(\d+)\s*(?:failed|skipped)', output)
        if match:
            passed = int(match.group(1))
            failed = int(match.group(2))
            print(f"  Vitest: {passed} passed, {failed} failed")

            # Show first 3 failures
            if failed > 0:
                fail_lines = []
                for line in output.split("\n"):
                    if "FAIL" in line or "×" in line:
                        fail_lines.append(line.strip()[:120])
                        if len(fail_lines) >= 3:
                            break
                for fl in fail_lines:
                    print(f"    {fl}")

            log(7, f"TypeScript client passes strict server ({passed}/{passed+failed})", failed == 0,
                f"{passed} passed, {failed} failed")
        else:
            ok = result.returncode == 0
            tail = output[-600:] if len(output) > 600 else output
            log(7, "TypeScript client test", ok, f"Exit: {result.returncode}\n{tail}")
    except subprocess.TimeoutExpired:
        log(7, "TypeScript client test", False, "Timed out after 120s")
    finally:
        with open(test_file, "w") as f:
            f.write(original)

# ─── Main ───

print("=" * 70)
print("A2A Auto E2E Test — Schema-strict server + TypeScript client")
print(f"Server: {STRICT_SERVER}")
print(f"Client: {CLIENT_DIR}")
print("=" * 70)

python_exe = find_python()
if not python_exe:
    # Try to install deps
    try:
        python_exe = install_deps(sys.executable)
    except Exception as e:
        print(f"❌ Cannot find Python with required deps: {e}")
        sys.exit(1)

try:
    if not start_server(python_exe):
        sys.exit(1)

    test_schema_validation()
    test_ts_client()
finally:
    stop_server()

print("\n" + "=" * 70)
total = len(results)
passed = sum(1 for _, _, s, _ in results if s)
failed = total - passed
print(f"Total: {total} | Passed: {passed} {PASS} | Failed: {failed} {FAIL}")

if failed > 0:
    print(f"\nFailures:")
    for n, nm, s, d in results:
        if not s:
            print(f"  ❌ [{n:02d}] {nm}")
            if d: print(f"      {d}")

sys.exit(1 if failed > 0 else 0)
