#!/usr/bin/env python3
import json
import base64
import hashlib
from http.server import HTTPServer, BaseHTTPRequestHandler
import urllib.parse
import threading

class MockState:
    def __init__(self):
        self.lock = threading.Lock()
        self.registry_id = "0xregistry123"
        self.table_id = "0xtable123"
        self.account_id = "0xaccount123"
        self.owner_address = "0xowner123"
        self.public_key_bytes = []  # Array of 32 integers
        self.blobs = {}             # blob_id -> bytes
        self.blob_object_ids = {}   # blob_id -> object_id
        self.blob_namespaces = {}   # blob_id -> namespace
        self.blob_counter = 0
        self.completions_call_count = 0
        self.embeddings_call_count = 0

state = MockState()

class MockHTTPRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # Suppress logging to keep output clean
        pass

    def _set_headers(self, status=200, content_type="application/json"):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers(200)

    def do_GET(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        # Aggregator check: GET /v1/blobs/{blob_id}
        if path.startswith("/v1/blobs/"):
            blob_id = path.replace("/v1/blobs/", "")
            with state.lock:
                if blob_id in state.blobs:
                    data = state.blobs[blob_id]
                    self._set_headers(200, "application/octet-stream")
                    self.wfile.write(data)
                    return
            self._set_headers(404)
            self.wfile.write(json.dumps({"error": f"Blob {blob_id} not found"}).encode())
            return

        # Default fallback
        self._set_headers(404)
        self.wfile.write(json.dumps({"error": f"Route not found: {path}"}).encode())

    def do_POST(self):
        parsed_url = urllib.parse.urlparse(self.path)
        path = parsed_url.path

        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        
        try:
            req_json = json.loads(post_data.decode('utf-8'))
        except Exception:
            req_json = {}

        # 1. Mock Key Registration (used by tests to configure public keys)
        if path == "/mock/register":
            with state.lock:
                state.public_key_bytes = req_json.get("public_key", [])
                state.account_id = req_json.get("account_id", state.account_id)
                state.owner_address = req_json.get("owner", state.owner_address)
            self._set_headers(200)
            self.wfile.write(json.dumps({"status": "ok"}).encode())
            return

        # 2. Sui JSON-RPC Endpoint (mocking sui_getObject and suix_getDynamicFields)
        if path == "/sui" or path == "/":
            method = req_json.get("method")
            params = req_json.get("params", [])
            req_id = req_json.get("id", 1)

            if method == "sui_getObject":
                obj_id = params[0] if params else ""
                with state.lock:
                    if obj_id == state.registry_id:
                        # Registry Object
                        result = {
                            "data": {
                                "objectId": state.registry_id,
                                "content": {
                                    "dataType": "moveObject",
                                    "fields": {
                                        "accounts": {
                                            "fields": {
                                                "id": {
                                                    "id": state.table_id
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    elif obj_id == "0xfield123" or obj_id.endswith("field123"):
                        # Dynamic field lookup, returns account ID
                        result = {
                            "data": {
                                "objectId": obj_id,
                                "content": {
                                    "dataType": "moveObject",
                                    "fields": {
                                        "value": state.account_id
                                    }
                                }
                            }
                        }
                    elif obj_id == state.account_id:
                        # Actual account object containing delegate keys
                        result = {
                            "data": {
                                "objectId": state.account_id,
                                "content": {
                                    "dataType": "moveObject",
                                    "fields": {
                                        "owner": state.owner_address,
                                        "active": True,
                                        "delegate_keys": [
                                            {
                                                "fields": {
                                                    "public_key": state.public_key_bytes
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                    else:
                        # Generic account object fallback
                        result = {
                            "data": {
                                "objectId": obj_id,
                                "content": {
                                    "dataType": "moveObject",
                                    "fields": {
                                        "owner": state.owner_address,
                                        "active": True,
                                        "delegate_keys": [
                                            {
                                                "fields": {
                                                    "public_key": state.public_key_bytes
                                                }
                                            }
                                        ]
                                    }
                                }
                            }
                        }
                self._set_headers(200)
                self.wfile.write(json.dumps({"jsonrpc": "2.0", "result": result, "id": req_id}).encode())
                return

            elif method == "suix_getDynamicFields":
                # Return dynamic fields for the table
                result = {
                    "data": [
                        {
                            "objectId": "0xfield123",
                            "name": "some_name",
                            "type": "DynamicField"
                        }
                    ],
                    "nextCursor": None,
                    "hasNextPage": False
                }
                self._set_headers(200)
                self.wfile.write(json.dumps({"jsonrpc": "2.0", "result": result, "id": req_id}).encode())
                return

        # 3. OpenAI Embeddings Mock
        if path == "/v1/embeddings":
            with state.lock:
                state.embeddings_call_count += 1
            input_text = req_json.get("input", "")
            # Generate deterministic embedding from text hash
            h = hashlib.sha256(input_text.encode() if isinstance(input_text, str) else b"").digest()
            mock_emb = []
            for i in range(1536):
                val = (h[i % len(h)] / 255.0) * 2.0 - 1.0
                mock_emb.append(val)
            response = {
                "data": [
                    {
                        "embedding": mock_emb
                    }
                ]
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # 4. OpenAI Chat Completions Mock
        if path == "/v1/chat/completions":
            with state.lock:
                state.completions_call_count += 1
            messages = req_json.get("messages", [])
            
            # Detect extraction prompt
            is_extraction = False
            for msg in messages:
                content = msg.get("content", "")
                if "extract" in content.lower() or "fact" in content.lower() or "dedup" in content.lower():
                    is_extraction = True
                    break

            if is_extraction:
                # Return list of mocked facts
                content = "vital\tThe user enjoys learning Rust.\nstandard\tThe user resides in Seattle.\ntrivial\tThe user prefers dark coffee."
            else:
                # Ask query response
                content = "Based on your memories, you enjoy learning Rust and reside in Seattle."

            response = {
                "choices": [
                    {
                        "message": {
                            "role": "assistant",
                            "content": content
                        }
                    }
                ]
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # 5. Walrus Sidecar Upload: POST /walrus/upload
        if path == "/walrus/upload":
            data_b64 = req_json.get("data", "")
            data_bytes = base64.b64decode(data_b64)
            namespace = req_json.get("namespace", "default")
            with state.lock:
                state.blob_counter += 1
                blob_id = f"mock-blob-{state.blob_counter}"
                object_id = f"0xmock-object-{state.blob_counter}"
                state.blobs[blob_id] = data_bytes
                state.blob_object_ids[blob_id] = object_id
                state.blob_namespaces[blob_id] = namespace
            response = {
                "blobId": blob_id,
                "objectId": object_id,
                "transferStatus": "success"
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # 6. Walrus Query Blobs: POST /walrus/query-blobs
        if path == "/walrus/query-blobs":
            owner = req_json.get("owner", "")
            namespace = req_json.get("namespace")
            pkg_id = req_json.get("packageId")
            with state.lock:
                blobs_list = []
                for b_id, data_bytes in state.blobs.items():
                    b_ns = state.blob_namespaces.get(b_id, "default")
                    if namespace and b_ns != namespace:
                        continue
                    blobs_list.append({
                        "blobId": b_id,
                        "objectId": state.blob_object_ids.get(b_id, "0xmock-object"),
                        "namespace": b_ns,
                        "packageId": pkg_id or "0xmock-package"
                    })
            response = {
                "blobs": blobs_list,
                "total": len(blobs_list)
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # 7. SEAL Threshold Encryption: POST /seal/encrypt
        if path == "/seal/encrypt":
            data_b64 = req_json.get("data", "")
            data_bytes = base64.b64decode(data_b64)
            # Prepend a mock signature/encryption header
            encrypted_bytes = b"MOCK_SEAL_ENCRYPTED:" + data_bytes
            encrypted_b64 = base64.b64encode(encrypted_bytes).decode('utf-8')
            response = {
                "encryptedData": encrypted_b64
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # 8. SEAL Decryption: POST /seal/decrypt
        if path == "/seal/decrypt":
            data_b64 = req_json.get("data", "")
            data_bytes = base64.b64decode(data_b64)
            # Remove mock signature/encryption header
            if data_bytes.startswith(b"MOCK_SEAL_ENCRYPTED:"):
                decrypted_bytes = data_bytes[len(b"MOCK_SEAL_ENCRYPTED:"):]
            else:
                decrypted_bytes = data_bytes
            decrypted_b64 = base64.b64encode(decrypted_bytes).decode('utf-8')
            response = {
                "decryptedData": decrypted_b64
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # 9. SEAL Decrypt Batch: POST /seal/decrypt-batch
        if path == "/seal/decrypt-batch":
            items = req_json.get("items", [])
            results = []
            for i, data_b64 in enumerate(items):
                data_bytes = base64.b64decode(data_b64)
                if data_bytes.startswith(b"MOCK_SEAL_ENCRYPTED:"):
                    decrypted_bytes = data_bytes[len(b"MOCK_SEAL_ENCRYPTED:"):]
                else:
                    decrypted_bytes = data_bytes
                decrypted_b64 = base64.b64encode(decrypted_bytes).decode('utf-8')
                results.append({
                    "index": i,
                    "decryptedData": decrypted_b64
                })
            response = {
                "results": results,
                "errors": []
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # 10. Sponsor Gas: POST /sponsor
        if path == "/sponsor":
            sender = req_json.get("sender", "")
            tb_bytes = req_json.get("transactionBlockKindBytes", "")
            # Return some mock sponsored transaction bytes
            response = {
                "txBytes": tb_bytes,
                "signature": base64.b64encode(b"mock-sponsor-signature-bytes-which-are-long-enough-to-be-valid").decode('utf-8')
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # 11. Sponsor Gas Execute: POST /sponsor/execute
        if path == "/sponsor/execute":
            digest = req_json.get("digest", "")
            response = {
                "digest": digest,
                "confirmed": True
            }
            self._set_headers(200)
            self.wfile.write(json.dumps(response).encode())
            return

        # Default fallback
        self._set_headers(404)
        self.wfile.write(json.dumps({"error": f"Route not found: {path}"}).encode())

def run_server(port=8080):
    server_address = ('', port)
    httpd = HTTPServer(server_address, MockHTTPRequestHandler)
    print(f"Mock server running on port {port}...")
    httpd.serve_forever()

if __name__ == '__main__':
    run_server()
