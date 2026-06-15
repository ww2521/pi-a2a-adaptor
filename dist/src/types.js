// ═══════════════════════════════════════════════════════════
// A2A Protocol Types — based on fasta2a v0.6.1 wire format
// ═══════════════════════════════════════════════════════════
// ─── JSON-RPC Error Codes ───
export var JSONRPCErrorCode;
(function (JSONRPCErrorCode) {
    JSONRPCErrorCode[JSONRPCErrorCode["ParseError"] = -32700] = "ParseError";
    JSONRPCErrorCode[JSONRPCErrorCode["InvalidRequest"] = -32600] = "InvalidRequest";
    JSONRPCErrorCode[JSONRPCErrorCode["MethodNotFound"] = -32601] = "MethodNotFound";
    JSONRPCErrorCode[JSONRPCErrorCode["InvalidParams"] = -32602] = "InvalidParams";
    JSONRPCErrorCode[JSONRPCErrorCode["InternalError"] = -32603] = "InternalError";
    JSONRPCErrorCode[JSONRPCErrorCode["TaskNotFound"] = -32001] = "TaskNotFound";
    JSONRPCErrorCode[JSONRPCErrorCode["TaskNotCancelable"] = -32002] = "TaskNotCancelable";
    JSONRPCErrorCode[JSONRPCErrorCode["PushNotificationNotSupported"] = -32003] = "PushNotificationNotSupported";
    JSONRPCErrorCode[JSONRPCErrorCode["UnsupportedOperation"] = -32004] = "UnsupportedOperation";
    JSONRPCErrorCode[JSONRPCErrorCode["ContentTypeNotSupported"] = -32005] = "ContentTypeNotSupported";
    JSONRPCErrorCode[JSONRPCErrorCode["InvalidAgentResponse"] = -32006] = "InvalidAgentResponse";
    JSONRPCErrorCode[JSONRPCErrorCode["TaskTimeout"] = -32007] = "TaskTimeout";
})(JSONRPCErrorCode || (JSONRPCErrorCode = {}));
