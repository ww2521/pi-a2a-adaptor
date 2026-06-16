#!/usr/bin/env python3
"""
strict-server.py — Schema-strict A2A test server for e2e testing.
Validates all incoming requests against fasta2a v0.6.1 pydantic schema.
"""
import uuid
import asyncio
import json
import sys
from datetime import datetime, timezone
from typing import Optional
from pydantic import BaseModel, field_validator
from starlette.applications import Starlette
from starlette.responses import Response, StreamingResponse
from starlette.requests import Request
from starlette.routing import Route
from starlette.middleware import Middleware
from starlette.middleware.cors import CORSMiddleware

# ─── A2A Schema (matches fasta2a v0.6.1) ───

class MessageSendConfiguration(BaseModel):
    acceptedOutputModes: list[str]
    blocking: Optional[bool] = None
    historyLength: Optional[int] = None
    pushNotificationConfig: Optional[dict] = None

class Message(BaseModel):
    kind: str
    role: str
    parts: list
    messageId: str
    contextId: Optional[str] = None
    taskId: Optional[str] = None
    metadata: Optional[dict] = None

    @field_validator("kind")
    @classmethod
    def check_kind(cls, v):
        if v != "message":
            raise ValueError(f"Expected 'message', got '{v}'")
        return v

    @field_validator("role")
    @classmethod
    def check_role(cls, v):
        if v not in ("user", "agent"):
            raise ValueError(f"Expected 'user' or 'agent', got '{v}'")
        return v

    @field_validator("parts")
    @classmethod
    def check_parts(cls, parts):
        for p in parts:
            if not isinstance(p, dict) or "kind" not in p:
                raise ValueError(f"Each part must have 'kind': {p}")
            if p["kind"] not in ("text", "file", "data"):
                raise ValueError(f"Invalid part kind: {p['kind']}")
            if p["kind"] == "text" and "text" not in p:
                raise ValueError(f"Text part missing 'text': {p}")
            if p["kind"] == "file" and "file" not in p:
                raise ValueError(f"File part missing 'file': {p}")
            if p["kind"] == "data" and "data" not in p:
                raise ValueError(f"Data part missing 'data': {p}")
        return parts

class MessageSendParams(BaseModel):
    message: Message
    configuration: Optional[MessageSendConfiguration] = None
    tenant: Optional[str] = None
    metadata: Optional[dict] = None

class TaskQueryParams(BaseModel):
    id: str
    historyLength: Optional[int] = None

class TaskIdParams(BaseModel):
    id: str

class ListTasksParams(BaseModel):
    contextId: Optional[str] = None
    status: Optional[str] = None
    pageSize: Optional[int] = None

class PushNotificationConfig(BaseModel):
    id: Optional[str] = None
    taskId: Optional[str] = None
    url: str
    token: Optional[str] = None

class PushSetParams(BaseModel):
    taskId: str
    url: str
    token: Optional[str] = None

class PushGetParams(BaseModel):
    taskId: str

class PushListParams(BaseModel):
    taskId: str

class PushDeleteParams(BaseModel):
    taskId: str
    id: str

# ─── State ───

tasks: dict = {}
push_configs: dict = {}  # task_id -> list

def make_task(message_data, context_id=None):
    task_id = str(uuid.uuid4())
    cid = context_id or str(uuid.uuid4())
    task = {
        "id": task_id,
        "contextId": cid,
        "kind": "task",
        "status": {
            "state": "submitted",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        },
        "artifacts": [],
        "metadata": {},
    }
    tasks[task_id] = task
    return task

def complete_task(task_id, user_text):
    tasks[task_id]["status"] = {
        "state": "completed",
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }
    tasks[task_id]["artifacts"] = [{
        "artifactId": str(uuid.uuid4()),
        "parts": [{"kind": "text", "text": f"Echo: {user_text}"}],
    }]

def echo_parts(parts):
    return " ".join(p.get("text", "") for p in parts if p.get("kind") == "text")

def make_jsonrpc_response(request_id, result=None, error=None):
    resp = {"jsonrpc": "2.0", "id": request_id}
    if error:
        resp["error"] = error
    else:
        resp["result"] = result
    return resp

def sse(data):
    return f"data: {json.dumps(data)}\n\n"

# ─── Handlers ───

async def handle_agent_card(request: Request):
    return Response(content=json.dumps({
        "name": "Strict A2A Server",
        "description": "Schema-strict A2A test server (matches fasta2a v0.6.1)",
        "url": f"http://127.0.0.1:{PORT}",
        "version": "1.0.0",
        "defaultInputModes": ["application/json"],
        "defaultOutputModes": ["application/json"],
        "capabilities": {"streaming": True, "pushNotifications": True, "stateTransitionHistory": False},
        "skills": [
            {"id": "echo", "name": "Echo", "description": "Echo back", "tags": ["test"]},
            {"id": "delay", "name": "Delay", "description": "Simulate delay", "tags": ["test", "delay"]},
        ],
    }), media_type="application/json")

def validate_params(model, params):
    try:
        model.model_validate(params)
        return None
    except Exception as e:
        return {"code": -32602, "message": f"Invalid params: {e}"}

async def handle_dispatch(request: Request):
    body = await request.json()
    request_id = body.get("id")
    method = body.get("method")
    params = body.get("params", {})

    validators = {
        "message/send": (MessageSendParams, _handle_send),
        "message/stream": (MessageSendParams, _handle_stream),
        "tasks/get": (TaskQueryParams, _handle_get),
        "tasks/cancel": (TaskIdParams, _handle_cancel),
        "tasks/list": (ListTasksParams, _handle_list),
        "tasks/resubscribe": (TaskIdParams, _handle_resubscribe),
        "tasks/pushNotification/set": (PushSetParams, _handle_push_set),
        "tasks/pushNotification/get": (PushGetParams, _handle_push_get),
        "tasks/pushNotificationConfig/list": (PushListParams, _handle_push_list),
        "tasks/pushNotificationConfig/delete": (PushDeleteParams, _handle_push_delete),
    }

    if method not in validators:
        return Response(
            content=json.dumps(make_jsonrpc_response(request_id, error={
                "code": -32601, "message": f"Method not found: {method}",
            })),
            media_type="application/json", status_code=200,
        )

    model, handler = validators[method]
    err = validate_params(model, params)
    if err:
        return Response(
            content=json.dumps(make_jsonrpc_response(request_id, error=err)),
            media_type="application/json", status_code=200,
        )

    return await handler(request_id, params)

async def _handle_send(request_id, params):
    msg = params["message"]
    context_id = msg.get("contextId")
    task = make_task(msg, context_id)
    user_text = echo_parts(msg.get("parts", []))

    # Check for delay:X pattern
    if user_text.startswith("delay:"):
        try:
            delay_secs = int(user_text.split(":")[1].strip())
        except (ValueError, IndexError):
            delay_secs = 3
        asyncio.create_task(_complete_after_delay(task["id"], delay_secs, user_text))
    else:
        complete_task(task["id"], user_text)

    return Response(
        content=json.dumps(make_jsonrpc_response(request_id, result={"kind": "task", "task": task})),
        media_type="application/json",
    )

async def _handle_stream(request_id, params):
    msg = params["message"]
    context_id = msg.get("contextId") or str(uuid.uuid4())
    task = make_task(msg, context_id)
    user_text = echo_parts(msg.get("parts", []))

    async def events():
        yield sse(make_jsonrpc_response(request_id, result={"kind": "task", "task": dict(task)}))

        task["status"]["state"] = "working"
        task["status"]["timestamp"] = datetime.now(timezone.utc).isoformat()
        yield sse(make_jsonrpc_response(request_id, result={
            "kind": "status-update", "taskId": task["id"], "contextId": task["contextId"],
            "status": task["status"], "final": False,
        }))

        artifact = {"artifactId": str(uuid.uuid4()), "parts": [{"kind": "text", "text": f"Echo: {user_text}"}]}
        task["artifacts"] = [artifact]
        yield sse(make_jsonrpc_response(request_id, result={
            "kind": "artifact-update", "taskId": task["id"], "contextId": task["contextId"],
            "artifact": artifact, "append": False, "lastChunk": True,
        }))

        task["status"]["state"] = "completed"
        task["status"]["timestamp"] = datetime.now(timezone.utc).isoformat()
        yield sse(make_jsonrpc_response(request_id, result={
            "kind": "status-update", "taskId": task["id"], "contextId": task["contextId"],
            "status": task["status"], "final": True,
        }))

        yield sse(make_jsonrpc_response(request_id, result={"kind": "task", "task": dict(task)}))

    return StreamingResponse(events(), media_type="text/event-stream")

async def _handle_get(request_id, params):
    task = tasks.get(params["id"])
    if not task:
        return Response(content=json.dumps(make_jsonrpc_response(request_id, error={
            "code": -32001, "message": "Task not found",
        })), media_type="application/json", status_code=200)
    result = dict(task)
    if params.get("historyLength"):
        result["history"] = []
    return Response(content=json.dumps(make_jsonrpc_response(request_id, result=result)), media_type="application/json")

async def _handle_cancel(request_id, params):
    task = tasks.get(params["id"])
    if not task:
        return Response(content=json.dumps(make_jsonrpc_response(request_id, error={
            "code": -32001, "message": "Task not found",
        })), media_type="application/json", status_code=200)
    task["status"]["state"] = "canceled"
    task["status"]["timestamp"] = datetime.now(timezone.utc).isoformat()
    return Response(content=json.dumps(make_jsonrpc_response(request_id, result=task)), media_type="application/json")

async def _handle_list(request_id, params):
    result = list(tasks.values())
    if params.get("status"):
        result = [t for t in result if t["status"]["state"] == params["status"]]
    if params.get("contextId"):
        result = [t for t in result if t.get("contextId") == params["contextId"]]
    total = len(result)
    page_size = params.get("pageSize", 50)
    return Response(content=json.dumps(make_jsonrpc_response(request_id, result={
        "tasks": result[:page_size], "totalSize": total, "pageSize": page_size,
    })), media_type="application/json")

async def _handle_resubscribe(request_id, params):
    task = tasks.get(params["id"])
    if not task:
        async def err():
            yield sse(make_jsonrpc_response(request_id, error={"code": -32001, "message": "Task not found"}))
        return StreamingResponse(err(), media_type="text/event-stream")
    async def events():
        yield sse(make_jsonrpc_response(request_id, result={"kind": "task", "task": dict(task)}))
        if task["status"]["state"] in ("completed", "failed", "canceled", "rejected"):
            return
    return StreamingResponse(events(), media_type="text/event-stream")

async def _handle_push_set(request_id, params):
    config_id = str(uuid.uuid4())
    config = {"id": config_id, "taskId": params["taskId"], "url": params["url"], "token": params.get("token", "")}
    push_configs.setdefault(params["taskId"], []).append(config)
    return Response(content=json.dumps(make_jsonrpc_response(request_id, result=config)), media_type="application/json")

async def _handle_push_get(request_id, params):
    configs = push_configs.get(params["taskId"], [])
    if not configs:
        return Response(content=json.dumps(make_jsonrpc_response(request_id, error={
            "code": -32003, "message": "Push notification not configured",
        })), media_type="application/json", status_code=200)
    return Response(content=json.dumps(make_jsonrpc_response(request_id, result=configs[0])), media_type="application/json")

async def _handle_push_list(request_id, params):
    return Response(content=json.dumps(make_jsonrpc_response(request_id, result={
        "configs": push_configs.get(params["taskId"], []),
    })), media_type="application/json")

async def _handle_push_delete(request_id, params):
    configs = push_configs.get(params["taskId"], [])
    configs = [c for c in configs if c["id"] != params["id"]]
    push_configs[params["taskId"]] = configs
    return Response(content=json.dumps(make_jsonrpc_response(request_id, result=None)), media_type="application/json")

async def _complete_after_delay(task_id, delay_secs, user_text):
    await asyncio.sleep(delay_secs)
    task = tasks.get(task_id)
    if task:
        complete_task(task_id, user_text)

# ─── App ───

PORT = 9996
app = Starlette(
    debug=True,
    routes=[
        Route("/.well-known/agent-card.json", handle_agent_card, methods=["GET"]),
        Route("/", handle_dispatch, methods=["POST"]),
    ],
    middleware=[Middleware(CORSMiddleware, allow_origins=["*"])],
)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="info")
