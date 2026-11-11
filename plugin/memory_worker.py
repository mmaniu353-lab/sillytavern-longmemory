"""Local line-delimited JSON RPC worker. No network listener and no API calls."""

import argparse
import json
import sys

from memory_store import MemoryStore
from vault_store import VaultStore


def reply(message):
    sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def run(database):
    store = MemoryStore(database)
    vault = VaultStore(store.connection)
    reply({"id": 0, "ready": True, "backend": "local-sqlite-v1"})
    try:
        while True:
            raw_line = sys.stdin.buffer.readline(160 * 1024 * 1024 + 1)
            if not raw_line:
                break
            if len(raw_line) > 160 * 1024 * 1024 or not raw_line.endswith(b'\n'):
                reply({"id": None, "ok": False, "error": "request_too_large"})
                break
            line = raw_line.decode('utf-8', errors='strict')
            request_id = None
            try:
                request = json.loads(line)
                if not isinstance(request, dict):
                    raise ValueError("invalid_request")
                request_id = request.get("id")
                args = request.get("args", {})
                if not isinstance(args, dict):
                    raise ValueError("invalid_args")
                op = request.get("op")
                if op in {"import_documents", "export_vault", "list_vault", "search_vault", "read_vault_item", "rebuild_index"}:
                    result = getattr(vault, op)(**args)
                elif op in {"put_confirmed", "put_batch_confirmed"}:
                    result = getattr(store, op)(**args)
                elif op == "put":
                    result = store.put(**args)
                elif op == "put_batch":
                    result = store.put_batch(**args)
                elif op == "put_archive":
                    result = store.put_archive(**args)
                elif op == "reconcile":
                    result = store.reconcile(**args)
                elif op == "manifest":
                    result = store.manifest(**args)
                elif op == "archive_states":
                    result = store.archive_states(**args)
                elif op == "archive_mark":
                    result = store.archive_mark(**args)
                elif op == "archive_forget":
                    result = store.archive_forget(**args)
                elif op == "recall":
                    result = store.recall(**args)
                elif op == "inspect_scope":
                    result = store.inspect_scope(**args)
                elif op == "get_item":
                    result = store.get_item(**args)
                elif op == "status":
                    result = store.status()
                elif op == "stop":
                    reply({"id": request_id, "ok": True, "result": "stopped"})
                    break
                else:
                    raise ValueError("unknown_operation")
                reply({"id": request_id, "ok": True, "result": result})
            except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
                code = str(error)
                if code not in {"request_too_large", "invalid_request", "invalid_args", "unknown_operation"}:
                    code = "invalid_input"
                reply({"id": request_id, "ok": False, "error": code})
            except Exception:
                reply({"id": request_id, "ok": False, "error": "internal_error"})
    finally:
        store.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    arguments = parser.parse_args()
    run(arguments.db)
