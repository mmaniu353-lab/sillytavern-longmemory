"""Durable, source-addressable evidence store for the local SillyTavern bridge.

This is a deterministic local retrieval layer, not a replacement name for any of
the research models in resources/. It never reads SillyTavern chat files.
"""

from __future__ import annotations

import hashlib
import re
import sqlite3
import time
from pathlib import Path


HAN = re.compile(r"[\u3400-\u9fff]+")
WORD = re.compile(r"[a-z0-9]+")
HAN_STOP = set("的了是在哪到后要我你他她它们和与从把将给这那什怎哪里来去有没")
MESSAGE_BYTES = 1024 * 1024
BATCH_BYTES = 8 * MESSAGE_BYTES
CHUNK_CHARS = 4000


def retrieval_chunks(text: str):
    for start in range(0, len(text), CHUNK_CHARS - 64):
        yield start, text[start:start + CHUNK_CHARS]


def validate_scope(*values) -> None:
    if not all(isinstance(value, str) and 0 < len(value) <= 160 for value in values):
        raise ValueError("invalid scope or source")
    try:
        for value in values:
            value.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("invalid scope encoding") from error


def validated_item(item: dict) -> dict:
    if not isinstance(item, dict):
        raise ValueError("invalid batch item")
    source, revision, text, role = (item.get(key) for key in ("source", "revision", "text", "role"))
    validate_scope(source)
    if type(revision) is not int or not 1 <= revision <= 9_007_199_254_740_991:
        raise ValueError("invalid revision")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("invalid text")
    try:
        raw = text.encode("utf-8")
    except UnicodeEncodeError as error:
        raise ValueError("invalid text encoding") from error
    if len(raw) > MESSAGE_BYTES:
        raise ValueError("text exceeds 1 MiB UTF-8 quota")
    if role not in ("user", "assistant"):
        raise ValueError("invalid role")
    return {"source": source, "revision": revision, "text": text, "role": role,
            "sha256": hashlib.sha256(raw).hexdigest(), "byte_len": len(raw)}


def terms_for(value: str) -> dict[str, float]:
    value = value.lower()
    terms: dict[str, float] = {}
    for segment in HAN.findall(value):
        for char in segment:
            if char not in HAN_STOP:
                terms[char] = 0.2
        for index in range(len(segment) - 1):
            terms[segment[index : index + 2]] = 1.0
    for word in WORD.findall(value):
        if len(word) > 1:
            terms[word] = 1.2
    return terms


class MemoryStore:
    def __init__(self, filename: str):
        Path(filename).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(filename, timeout=10)
        self.connection.row_factory = sqlite3.Row
        self.connection.execute("PRAGMA journal_mode = WAL")
        self.connection.execute("PRAGMA synchronous = NORMAL")
        self.connection.execute("PRAGMA cache_size = -64000")
        self.connection.execute("PRAGMA temp_store = MEMORY")
        self.connection.execute("PRAGMA busy_timeout = 15000")
        version = self.connection.execute("PRAGMA user_version").fetchone()[0]
        if version > 3:
            self.connection.close()
            raise ValueError("unsupported database version")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS memory (
                user_scope TEXT NOT NULL,
                world TEXT NOT NULL,
                chat TEXT NOT NULL,
                source TEXT NOT NULL,
                revision INTEGER NOT NULL,
                body TEXT NOT NULL,
                role TEXT NOT NULL,
                active INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_scope, chat, source)
            );
            CREATE INDEX IF NOT EXISTS memory_world_active
                ON memory (user_scope, world, active, updated_at);
            CREATE TABLE IF NOT EXISTS term_index (
                user_scope TEXT NOT NULL,
                world TEXT NOT NULL,
                term TEXT NOT NULL,
                chat TEXT NOT NULL,
                source TEXT NOT NULL,
                weight REAL NOT NULL,
                PRIMARY KEY (user_scope, chat, source, term)
            );
            CREATE INDEX IF NOT EXISTS terms_lookup
                ON term_index (user_scope, world, term);
            CREATE TABLE IF NOT EXISTS archive_state (
                user_scope TEXT NOT NULL,
                world TEXT NOT NULL,
                card TEXT NOT NULL,
                chat TEXT NOT NULL,
                stamp TEXT NOT NULL,
                source_count INTEGER NOT NULL,
                completed_at INTEGER NOT NULL,
                PRIMARY KEY (user_scope, world, card, chat)
            );
            """
        )
        self._migrate(version)

    def _migrate(self, previous_version: int) -> None:
        with self.connection:
            self.connection.execute("BEGIN IMMEDIATE")
            columns = {row[1] for row in self.connection.execute("PRAGMA table_info(memory)")}
            if "sha256" not in columns:
                self.connection.execute("ALTER TABLE memory ADD COLUMN sha256 TEXT NOT NULL DEFAULT ''")
            self.connection.execute(
                """CREATE TABLE IF NOT EXISTS memory_version (
                       user_scope TEXT NOT NULL,
                       world TEXT NOT NULL,
                       chat TEXT NOT NULL,
                       source TEXT NOT NULL,
                       revision INTEGER NOT NULL,
                       body TEXT NOT NULL,
                       sha256 TEXT NOT NULL,
                       role TEXT NOT NULL,
                       updated_at INTEGER NOT NULL,
                       PRIMARY KEY (user_scope, chat, source, revision)
                   )"""
            )
            self.connection.execute(
                """CREATE TABLE IF NOT EXISTS retrieval_chunk (
                       user_scope TEXT NOT NULL,
                       chat TEXT NOT NULL,
                       source TEXT NOT NULL,
                       offset INTEGER NOT NULL,
                       body TEXT NOT NULL,
                       PRIMARY KEY (user_scope, chat, source, offset)
                   )"""
            )
            self.connection.execute(
                """CREATE TABLE IF NOT EXISTS chunk_term (
                       user_scope TEXT NOT NULL,
                       world TEXT NOT NULL,
                       chat TEXT NOT NULL,
                       source TEXT NOT NULL,
                       offset INTEGER NOT NULL,
                       term TEXT NOT NULL,
                       weight REAL NOT NULL,
                       PRIMARY KEY (user_scope, chat, source, offset, term)
                   )"""
            )
            self.connection.execute(
                """CREATE INDEX IF NOT EXISTS chunk_terms_lookup
                       ON chunk_term (user_scope, world, term)"""
            )
            if previous_version < 3 or "sha256" not in columns:
                cursor = self.connection.execute(
                    """SELECT
                           user_scope,
                           world,
                           chat,
                           source,
                           revision,
                           body,
                           role,
                           active,
                           updated_at
                       FROM
                           memory"""
                )
                while True:
                    rows = cursor.fetchmany(64)
                    if not rows:
                        break
                    for row in rows:
                        body_hash = hashlib.sha256(row["body"].encode("utf-8")).hexdigest()
                        self.connection.execute(
                            """UPDATE
                                   memory
                               SET
                                   sha256 = ?
                               WHERE
                                   user_scope = ?
                                   AND chat = ?
                                   AND source = ?""",
                            (body_hash, row["user_scope"], row["chat"], row["source"]),
                        )
                        self.connection.execute(
                            """INSERT OR IGNORE INTO
                                   memory_version (user_scope, world, chat, source, revision,
                                                   body, sha256, role, updated_at)
                               VALUES
                                   (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            (row["user_scope"], row["world"], row["chat"], row["source"],
                             row["revision"], row["body"], body_hash, row["role"], row["updated_at"]),
                        )
                        if row["active"]:
                            self._replace_retrieval(row["user_scope"], row["world"], row["chat"],
                                                    row["source"], row["body"])
            self.connection.execute("PRAGMA user_version = 3")

    def _replace_retrieval(self, user_scope: str, world: str, chat: str,
                           source: str, text: str) -> None:
        for table in ("term_index", "chunk_term", "retrieval_chunk"):
            self.connection.execute(
                f"""DELETE FROM
                        {table}
                    WHERE
                        user_scope = ?
                        AND chat = ?
                        AND source = ?""", (user_scope, chat, source),
            )
        chunks = list(retrieval_chunks(text))
        self.connection.executemany(
            """INSERT INTO
                   retrieval_chunk (user_scope, chat, source, offset, body)
               VALUES
                   (?, ?, ?, ?, ?)""",
            [(user_scope, chat, source, offset, body) for offset, body in chunks],
        )
        for offset, body in chunks:
            self.connection.executemany(
                """INSERT INTO
                       chunk_term (user_scope, world, chat, source, offset, term, weight)
                   VALUES
                       (?, ?, ?, ?, ?, ?, ?)""",
                [(user_scope, world, chat, source, offset, term, weight)
                 for term, weight in terms_for(body).items()],
            )

    def close(self) -> None:
        self.connection.close()

    def put_archive(self, user_scope: str, world: str, chat: str, source: str,
                    text: str, role: str, min_revision: int = 1,
                    skip_if_active: bool = False) -> str:
        validate_scope(user_scope, world, chat)
        validated_item({"source": source, "revision": min_revision, "text": text, "role": role})
        old = self.connection.execute(
            """SELECT
                   revision,
                   active,
                   body,
                   role,
                   world
               FROM
                   memory
               WHERE
                   user_scope = ?
                   AND chat = ?
                   AND source = ?""",
            (user_scope, chat, source),
        ).fetchone()
        if old and old["active"] and skip_if_active and \
                old["body"] == text and old["role"] == role and old["world"] == world:
            return "duplicate"
        revision = max(min_revision, (old["revision"] + 1) if old else 1)
        return self.put(user_scope, world, chat, source, revision, text, role)

    def put(self, user_scope: str, world: str, chat: str, source: str,
            revision: int, text: str, role: str) -> str:
        ack = self.put_confirmed(user_scope, world, chat, source, revision, text, role)
        return "duplicate" if ack["status"] == "unchanged" else "applied"

    def put_confirmed(self, user_scope: str, world: str, chat: str, source: str,
                      revision: int, text: str, role: str) -> dict:
        return self.put_batch_confirmed(user_scope, world, chat, [
            {"source": source, "revision": revision, "text": text, "role": role}
        ])[0]

    def put_batch_confirmed(self, user_scope: str, world: str, chat: str,
                            items: list[dict]) -> list[dict]:
        validate_scope(user_scope, world, chat)
        if not isinstance(items, list) or len(items) > 2000:
            raise ValueError("invalid batch")
        prepared = [validated_item(item) for item in items]
        if sum(item["byte_len"] for item in prepared) > BATCH_BYTES:
            raise ValueError("batch exceeds 8 MiB UTF-8 quota")
        acks, changes, known = [], [], {}
        now_ts = int(time.time())
        with self.connection:
            # Lock before reading revisions: separate worker connections cannot race validation.
            self.connection.execute("BEGIN IMMEDIATE")
            for item in prepared:
                source = item["source"]
                if source not in known:
                    row = self.connection.execute(
                        """SELECT
                               revision,
                               sha256,
                               role,
                               world,
                               active
                           FROM
                               memory
                           WHERE
                               user_scope = ?
                               AND chat = ?
                               AND source = ?""", (user_scope, chat, source),
                    ).fetchone()
                    known[source] = dict(row) if row else None
                old = known[source]
                if old and item["revision"] < old["revision"]:
                    raise ValueError("stale revision")
                same_revision = bool(old and item["revision"] == old["revision"])
                if same_revision and (item["sha256"] != old["sha256"]
                                      or item["role"] != old["role"] or world != old["world"]):
                    raise ValueError("revision conflict")
                unchanged = same_revision and old["active"]
                acks.append({"source": source, "revision": item["revision"],
                             "sha256": item["sha256"],
                             "status": "unchanged" if unchanged else "stored"})
                if not unchanged:
                    changes.append((item, not same_revision))
                known[source] = {"revision": item["revision"], "sha256": item["sha256"],
                                 "role": item["role"], "world": world, "active": 1}
            # Validate the entire batch and its in-order revision transitions before writing.
            self.connection.executemany(
                """INSERT INTO
                       memory_version (user_scope, world, chat, source, revision,
                                       body, sha256, role, updated_at)
                   VALUES
                       (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                [(user_scope, world, chat, item["source"], item["revision"], item["text"],
                  item["sha256"], item["role"], now_ts) for item, is_new in changes if is_new],
            )
            self.connection.executemany(
                """INSERT INTO
                       memory (user_scope, world, chat, source, revision, body,
                               sha256, role, active, updated_at)
                   VALUES
                       (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
                   ON CONFLICT (user_scope, chat, source)
                   DO UPDATE SET
                       world = excluded.world,
                       revision = excluded.revision,
                       body = excluded.body,
                       sha256 = excluded.sha256,
                       role = excluded.role,
                       active = 1,
                       updated_at = excluded.updated_at""",
                [(user_scope, world, chat, item["source"], item["revision"], item["text"],
                  item["sha256"], item["role"], now_ts) for item, _ in changes],
            )
            latest = {item["source"]: item for item, _ in changes}
            for source, item in latest.items():
                self._replace_retrieval(user_scope, world, chat, source, item["text"])
        return acks

    def reconcile(self, user_scope: str, chat: str, present_sources: list[str],
                  mode: str = "live") -> int:
        validate_scope(user_scope, chat)
        if not isinstance(present_sources, list) or len(present_sources) > 200000:
            raise ValueError("invalid source list")
        if not all(isinstance(source, str) and 0 < len(source) <= 160 for source in present_sources):
            raise ValueError("invalid source")
        if mode not in ("live", "archive", "all"):
            raise ValueError("invalid reconcile mode")
        present = set(present_sources)
        if mode == "all" and not present:
            with self.connection:
                count = self.connection.execute(
                    """SELECT
                           COUNT(*)
                       FROM
                           memory
                       WHERE
                           user_scope = ?
                           AND chat = ?
                           AND active = 1""",
                    (user_scope, chat),
                ).fetchone()[0]
                self.connection.execute(
                    """UPDATE
                           memory
                       SET
                           active = 0,
                           updated_at = ?
                       WHERE
                           user_scope = ?
                           AND chat = ?
                           AND active = 1""",
                    (int(time.time()), user_scope, chat),
                )
                self.connection.execute(
                    """DELETE FROM
                           term_index
                       WHERE
                           user_scope = ?
                           AND chat = ?""",
                    (user_scope, chat),
                )
                for table in ("chunk_term", "retrieval_chunk"):
                    self.connection.execute(
                        f"""DELETE FROM
                                {table}
                            WHERE
                                user_scope = ?
                                AND chat = ?""", (user_scope, chat),
                    )
            return count
        with self.connection:
            rows = self.connection.execute(
                """SELECT
                       source
                   FROM
                       memory
                   WHERE
                       user_scope = ?
                       AND chat = ?
                       AND active = 1""",
                (user_scope, chat),
            ).fetchall()
            removed = [row["source"] for row in rows
                       if row["source"] not in present
                       and (mode == "all"
                            or row["source"].startswith("legacy:") == (mode == "archive"))]
            for source in removed:
                self.connection.execute(
                    """UPDATE
                           memory
                       SET
                           active = 0,
                           updated_at = ?
                       WHERE
                           user_scope = ?
                           AND chat = ?
                           AND source = ?""",
                    (int(time.time()), user_scope, chat, source),
                )
                self.connection.execute(
                    """DELETE FROM
                           term_index
                       WHERE
                           user_scope = ?
                           AND chat = ?
                           AND source = ?""",
                    (user_scope, chat, source),
                )
                for table in ("chunk_term", "retrieval_chunk"):
                    self.connection.execute(
                        f"""DELETE FROM
                                {table}
                            WHERE
                                user_scope = ?
                                AND chat = ?
                                AND source = ?""", (user_scope, chat, source),
                    )
        return len(removed)

    def archive_states(self, user_scope: str, world: str, card: str) -> dict:
        rows = self.connection.execute(
            """SELECT
                   chat,
                   stamp,
                   source_count
               FROM
                   archive_state
               WHERE
                   user_scope = ?
                   AND world = ?
                   AND card = ?""",
            (user_scope, world, card),
        ).fetchall()
        return {row["chat"]: {"stamp": row["stamp"], "source_count": row["source_count"]}
                for row in rows}

    def archive_mark(self, user_scope: str, world: str, card: str, chat: str,
                     stamp: str, source_count: int) -> None:
        if not all(isinstance(value, str) and 0 < len(value) <= 160
                   for value in (user_scope, world, card, chat)):
            raise ValueError("invalid archive scope")
        if not isinstance(stamp, str) or not stamp or len(stamp) > 128:
            raise ValueError("invalid archive stamp")
        if not isinstance(source_count, int) or not 0 <= source_count <= 200000:
            raise ValueError("invalid source count")
        with self.connection:
            self.connection.execute(
                """INSERT INTO
                       archive_state (user_scope, world, card, chat, stamp, source_count, completed_at)
                   VALUES
                       (?, ?, ?, ?, ?, ?, ?)
                   ON CONFLICT (user_scope, world, card, chat)
                   DO UPDATE SET
                       stamp = excluded.stamp,
                       source_count = excluded.source_count,
                       completed_at = excluded.completed_at""",
                (user_scope, world, card, chat, stamp, source_count, int(time.time())),
            )

    def archive_forget(self, user_scope: str, world: str, card: str, chat: str) -> None:
        with self.connection:
            self.connection.execute(
                """DELETE FROM
                       archive_state
                   WHERE
                       user_scope = ?
                       AND world = ?
                       AND card = ?
                       AND chat = ?""",
                (user_scope, world, card, chat),
            )

    def manifest(self, user_scope: str, chat: str) -> dict[str, int]:
        rows = self.connection.execute(
            """SELECT
                   source,
                   revision
               FROM
                   memory
               WHERE
                   user_scope = ?
                   AND chat = ?
                   AND active = 1""",
            (user_scope, chat),
        ).fetchall()
        return {row["source"]: row["revision"] for row in rows}

    def _candidates(self, user_scope: str, world: str, terms: set[str], cap: int = 150):
        if not terms:
            return []
        selected = sorted(terms, key=lambda t: (-len(t), t))[:64]
        placeholders = ", ".join("?" for _ in selected)
        return self.connection.execute(
            f"""SELECT DISTINCT
                    m.chat,
                    m.source,
                    m.revision,
                    c.offset,
                    c.body,
                    LENGTH(m.body) AS full_length,
                    m.role,
                    m.updated_at
                FROM
                    chunk_term t
                    JOIN memory m
                        ON m.user_scope = t.user_scope
                        AND m.chat = t.chat
                        AND m.source = t.source
                    JOIN retrieval_chunk c
                        ON c.user_scope = t.user_scope
                        AND c.chat = t.chat
                        AND c.source = t.source
                        AND c.offset = t.offset
                WHERE
                    t.user_scope = ?
                    AND t.world = ?
                    AND m.world = ?
                    AND t.term IN ({placeholders})
                    AND m.active = 1
                ORDER BY
                    m.updated_at DESC
                LIMIT
                    ?""",
            (user_scope, world, world, *selected, cap),
        ).fetchall()

    def recall(self, user_scope: str, world: str, chat: str, query: str,
               limit: int = 6, max_chars: int = 1800,
               exclude_sources: list[str] | None = None) -> list[dict]:
        validate_scope(user_scope, world, chat)
        if not isinstance(query, str) or len(query) > 4000:
            raise ValueError("invalid query")
        if not isinstance(limit, int) or not 1 <= limit <= 12:
            raise ValueError("invalid limit")
        if not isinstance(max_chars, int) or not 64 <= max_chars <= 6000:
            raise ValueError("invalid budget")
        excluded = set(exclude_sources or []) if isinstance(exclude_sources, list) else set()
        query_terms = terms_for(query)
        sorted_terms = [t for t, _ in sorted(query_terms.items(), key=lambda kv: -kv[1])[:64]]
        candidates = self._candidates(user_scope, world, set(sorted_terms), cap=150)
        scored = []
        seen = set()
        for row in candidates:
            if row["chat"] == chat and row["source"] in excluded:
                continue
            document_terms = terms_for(row["body"])
            overlap = query_terms.keys() & document_terms.keys()
            score = sum(query_terms[term] * document_terms[term] for term in overlap)
            if score >= 0.7:
                key = (row["chat"], row["source"], row["offset"])
                seen.add(key)
                top_matched = sorted(overlap, key=lambda t: -(query_terms[t] * document_terms[t]))[:6]
                scored.append((score, row, "direct", top_matched, None))
        scored.sort(key=lambda item: (-item[0], -item[1]["updated_at"]))
        # Bounded expansion only if we don't already have enough direct matches
        if len(scored) < limit:
            frontier = scored[:2]
            for hop in range(1):
                new_frontier = []
                for seed_score, seed, _, _, _ in frontier:
                    seed_terms = terms_for(seed["body"])
                    strong_terms = {term for term in seed_terms
                                    if len(term) >= 2 and term not in query_terms}
                    top_strong = sorted(strong_terms, key=lambda t: -seed_terms.get(t, 0))[:32]
                    for neighbor in self._candidates(user_scope, world, set(top_strong), cap=30):
                        if neighbor["chat"] == chat and neighbor["source"] in excluded:
                            continue
                        key = (neighbor["chat"], neighbor["source"], neighbor["offset"])
                        if key in seen:
                            continue
                        common = set(top_strong) & terms_for(neighbor["body"]).keys()
                        if not common:
                            continue
                        score = min(seed_score * 0.46, 2.0) + min(len(common), 3) * 0.2
                        seen.add(key)
                        top_common = sorted(common, key=lambda t: -seed_terms.get(t, 0))[:6]
                        item = (score, neighbor, f"linked-{hop + 1}", top_common, seed["source"])
                        scored.append(item)
                        new_frontier.append(item)
                frontier = sorted(new_frontier, key=lambda item: -item[0])[:2]
                if not frontier:
                    break
        scored.sort(key=lambda item: (-item[0], -item[1]["updated_at"]))
        result = []
        remaining = max_chars
        seen_bodies = set()
        for score, row, match_kind, matched_terms, via_source in scored:
            if len(result) >= limit or remaining <= 0:
                break
            signature = (row["body"], row["role"])
            if signature in seen_bodies:
                continue
            seen_bodies.add(signature)
            snippet_start = 0
            if len(row["body"]) > remaining:
                lowered = row["body"].lower()
                positions = [lowered.find(term) for term in matched_terms if term in lowered]
                if positions:
                    snippet_start = max(0, min(min(positions) - remaining // 3,
                                               len(row["body"]) - remaining))
            body = row["body"][snippet_start:snippet_start + remaining]
            result.append({
                "text": body,
                "full_length": row["full_length"],
                "offset": row["offset"] + snippet_start,
                "source": row["source"],
                "chat": row["chat"],
                "is_current_chat": row["chat"] == chat,
                "revision": row["revision"],
                "role": row["role"],
                "match": match_kind,
                "score": round(float(score), 3),
                "matched_terms": matched_terms,
                "via_source": via_source,
                "updated_at": row["updated_at"],
            })
            remaining -= len(body)
        return result

    def put_batch(self, user_scope: str, world: str, chat: str, items: list[dict]) -> int:
        return sum(ack["status"] == "stored"
                   for ack in self.put_batch_confirmed(user_scope, world, chat, items))

    def inspect_scope(self, user_scope: str, world: str, chat: str,
                      limit: int = 48) -> dict:
        if not all(isinstance(x, str) and 0 < len(x) <= 160 for x in (user_scope, world, chat)):
            raise ValueError("invalid scope")
        cap = max(10, min(int(limit or 48), 80))
        rows = self.connection.execute(
            """SELECT
                   chat,
                   source,
                   revision,
                   SUBSTR(body, 1, 120) AS preview,
                   LENGTH(body) AS char_len,
                   role,
                   updated_at
               FROM
                   memory
               WHERE
                   user_scope = ?
                   AND world = ?
                   AND active = 1
               ORDER BY
                   CASE WHEN chat = ? THEN 0 ELSE 1 END,
                   updated_at DESC
               LIMIT
                   ?""",
            (user_scope, world, chat, cap),
        ).fetchall()
        total_world = self.connection.execute(
            """SELECT
                   COUNT(*),
                   COALESCE(SUM(LENGTH(body)), 0)
               FROM
                   memory
               WHERE
                   user_scope = ?
                   AND world = ?
                   AND active = 1""",
            (user_scope, world),
        ).fetchone()
        total_current_chat = self.connection.execute(
            """SELECT
                   COUNT(*),
                   COALESCE(SUM(LENGTH(body)), 0)
               FROM
                   memory
               WHERE
                   user_scope = ?
                   AND chat = ?
                   AND active = 1""",
            (user_scope, chat),
        ).fetchone()

        nodes = []
        for idx, row in enumerate(rows):
            node_id = f"{row['chat'][:12]}:{row['source']}"
            nodes.append({
                "id": node_id,
                "seq": idx + 1,
                "chat": row["chat"],
                "is_current_chat": row["chat"] == chat,
                "is_legacy_archive": row["source"].startswith("legacy:"),
                "source": row["source"],
                "revision": row["revision"],
                "role": row["role"],
                "preview": row["preview"] or "",
                "char_len": int(row["char_len"] or 0),
                "updated_at": row["updated_at"],
            })

        return {
            "world_total_nodes": int(total_world[0] or 0),
            "world_total_chars": int(total_world[1] or 0),
            "chat_total_nodes": int(total_current_chat[0] or 0),
            "chat_total_chars": int(total_current_chat[1] or 0),
            "nodes": nodes,
            "edges": [],
        }

    def get_item(self, user_scope: str, world: str, chat: str, source: str) -> dict | None:
        validate_scope(user_scope, world, chat, source)
        row = self.connection.execute(
            """SELECT
                   chat,
                   source,
                   revision,
                   body,
                   sha256,
                   role,
                   updated_at
               FROM
                   memory
               WHERE
                   user_scope = ?
                   AND world = ?
                   AND chat = ?
                   AND source = ?
                   AND active = 1""",
            (user_scope, world, chat, source),
        ).fetchone()
        if not row:
            return None
        t_map = terms_for(row["body"][:CHUNK_CHARS])
        strong = [t for t, w in sorted(t_map.items(), key=lambda kv: (-kv[1], -len(kv[0]))) if len(t) >= 2][:8]
        return {
            "chat": row["chat"],
            "source": row["source"],
            "revision": row["revision"],
            "role": row["role"],
            "body": row["body"],
            "sha256": row["sha256"],
            "char_len": len(row["body"]),
            "updated_at": row["updated_at"],
            "top_terms": strong,
        }

    def status(self) -> dict:
        count = self.connection.execute(
            """SELECT
                   COUNT(*)
               FROM
                   memory
               WHERE
                   active = 1"""
        ).fetchone()[0]
        return {"ready": True, "active_sources": count, "backend": "local-sqlite-v1"}
