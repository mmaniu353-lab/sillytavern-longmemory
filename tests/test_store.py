import hashlib
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "plugin"))
import memory_store
from memory_store import MemoryStore


def digest(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.temp.name) / "memory.sqlite")
        self.store = MemoryStore(self.path)

    def tearDown(self):
        self.store.close()
        self.temp.cleanup()

    def put(self, text="original evidence", revision=1, source="s", chat="c", user="u", world="w"):
        return self.store.put_confirmed(user, world, chat, source, revision, text, "user")

    def item(self, source="s", chat="c", user="u", world="w"):
        return self.store.get_item(user, world, chat, source)

    def history(self, source="s"):
        return self.store.connection.execute(
            """SELECT
                   revision,
                   body,
                   sha256
               FROM
                   memory_version
               WHERE
                   user_scope = ?
                   AND chat = ?
                   AND source = ?
               ORDER BY
                   revision""", ("u", "c", source)).fetchall()

    def test_confirmed_hash_and_idempotence(self):
        text = "evidence\n世界😀 "
        self.assertEqual(self.put(text), {"source": "s", "revision": 1, "sha256": digest(text), "status": "stored"})
        self.assertEqual(self.put(text)["status"], "unchanged")
        self.assertEqual(len(self.history()), 1)
        self.assertEqual(self.item()["body"], text)
        self.assertEqual(self.item()["chat"], "c")
        self.assertEqual(self.item()["sha256"], digest(text))

    def test_full_text_12001_characters(self):
        text = "a" * 12001
        self.assertEqual(self.put(text)["sha256"], digest(text))
        self.assertEqual(self.item()["body"], text)

    def test_unicode_100000_suffix_edit_restart(self):
        first = "雪" * 99997 + "😀甲终"
        second = first[:-1] + "改"
        self.put(first)
        self.assertEqual(self.put(second, 2)["sha256"], digest(second))
        self.store.close()
        self.store = MemoryStore(self.path)
        self.assertEqual(self.item()["body"], second)
        self.assertEqual(self.item()["char_len"], 100000)
        self.assertEqual([(r["revision"], r["body"], r["sha256"]) for r in self.history()],
                         [(1, first, digest(first)), (2, second, digest(second))])

    def test_same_revision_conflicts_and_stale_rejected(self):
        self.put("new", 2)
        for text, rev in [("old", 1), ("changed", 2)]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                self.put(text, rev)
        with self.assertRaises(ValueError):
            self.store.put_confirmed("u", "w", "c", "s", 2, "new", "assistant")
        self.assertEqual(self.item()["body"], "new")
        self.assertEqual(len(self.history()), 1)

    def test_strict_legacy_api_and_batch(self):
        self.assertEqual(self.store.put("u", "w", "c", "s", 1, "body", "user"), "applied")
        self.assertEqual(self.store.put("u", "w", "c", "s", 1, "body", "user"), "duplicate")
        with self.assertRaises(ValueError):
            self.store.put("u", "w", "c", "s", 0, "body", "user")
        with self.assertRaises(ValueError):
            self.store.put_batch("u", "w", "c", [None])

    def test_atomic_invalid_batch(self):
        good = {"source": "one", "revision": 1, "text": "one", "role": "user"}
        for bad in [None, {}, {**good, "source": "two", "text": ""},
                    {**good, "source": "two", "revision": True},
                    {**good, "source": "two", "text": "\ud800"}]:
            with self.subTest(bad=str(bad)[:80]), self.assertRaises(ValueError):
                self.store.put_batch_confirmed("u", "w", "c", [good, bad])
            self.assertEqual(self.store.manifest("u", "c"), {})

    def test_batch_ack_order_and_atomic_revision_conflict(self):
        self.put("exists", 2)
        new = {"source": "new", "revision": 1, "text": "new", "role": "assistant"}
        stale = {"source": "s", "revision": 1, "text": "exists", "role": "user"}
        with self.assertRaises(ValueError):
            self.store.put_batch_confirmed("u", "w", "c", [new, stale])
        self.assertIsNone(self.item("new"))
        self.assertEqual(self.history("new"), [])
        acks = self.store.put_batch_confirmed("u", "w", "c", [new, {**stale, "revision": 2}])
        self.assertEqual([(a["source"], a["status"]) for a in acks], [("new", "stored"), ("s", "unchanged")])
        self.assertEqual(acks[0]["sha256"], digest("new"))

    def test_duplicate_source_inside_batch_is_strict_and_atomic(self):
        item = {"source": "s", "revision": 1, "text": "one", "role": "user"}
        with self.assertRaises(ValueError):
            self.store.put_batch_confirmed("u", "w", "c", [item, {**item, "text": "two"}])
        self.assertEqual(self.store.manifest("u", "c"), {})
        acks = self.store.put_batch_confirmed("u", "w", "c", [item, item])
        self.assertEqual([ack["status"] for ack in acks], ["stored", "unchanged"])

    def test_utf8_message_and_batch_quotas(self):
        valid = "雪" * (1048576 // 3)
        self.put(valid)
        with self.assertRaises(ValueError):
            self.put(valid + "雪", 2)
        item = {"source": "limit", "revision": 1, "text": "a" * 1048576, "role": "user"}
        with self.assertRaises(ValueError):
            self.store.put_batch_confirmed("u", "w", "other", [{**item, "source": str(n)} for n in range(9)])
        with self.assertRaises(ValueError):
            self.store.put_batch_confirmed("u", "w", "other", [{**item, "text": "x"}] * 2001)
        self.assertEqual(self.store.manifest("u", "other"), {})

    def test_exact_quota_boundaries_are_accepted(self):
        item = {"source": "s", "revision": 1, "text": "x" * 1048576, "role": "user"}
        acks = self.store.put_batch_confirmed("u", "w", "c", [item] * 8)
        self.assertEqual([a["status"] for a in acks], ["stored"] + ["unchanged"] * 7)
        self.assertEqual(self.item()["body"], item["text"])
        tiny = {"source": "tiny", "revision": 1, "text": "ok", "role": "user"}
        self.assertEqual(len(self.store.put_batch_confirmed("u", "w", "c", [tiny] * 2000)), 2000)

    def test_in_order_multi_revision_batch_preserves_each_version(self):
        item = {"source": "s", "revision": 1, "text": "one", "role": "user"}
        acks = self.store.put_batch_confirmed("u", "w", "c", [item, {**item, "revision": 2, "text": "two"}])
        self.assertEqual([a["sha256"] for a in acks], [digest("one"), digest("two")])
        self.assertEqual([r["body"] for r in self.history()], ["one", "two"])
        self.assertEqual(self.item()["body"], "two")

    def test_storage_error_rolls_back_entire_batch_and_history(self):
        self.put("initial")
        items = [{"source": "s", "revision": 2, "text": "updated", "role": "user"},
                 {"source": "other", "revision": 1, "text": "other", "role": "user"}]
        original = self.store._replace_retrieval
        def fail_second(user, world, chat, source, text):
            if source == "other":
                raise sqlite3.OperationalError("injected index failure")
            return original(user, world, chat, source, text)
        with patch.object(self.store, "_replace_retrieval", fail_second), self.assertRaises(sqlite3.OperationalError):
            self.store.put_batch_confirmed("u", "w", "c", items)
        self.assertEqual(self.item()["body"], "initial")
        self.assertIsNone(self.item("other"))
        self.assertEqual([r["body"] for r in self.history()], ["initial"])
        self.assertEqual(self.history("other"), [])

    def test_legacy_stale_rejected_and_archive_keeps_versions(self):
        self.put("new", 2)
        with self.assertRaises(ValueError):
            self.store.put("u", "w", "c", "s", 1, "stale", "user")
        self.assertEqual(self.store.put_archive("u", "w", "c", "legacy:one", "original", "user"), "applied")
        self.assertEqual(self.store.put_archive("u", "w", "c", "legacy:one", "original", "user", skip_if_active=True), "duplicate")
        self.assertEqual(self.store.put_archive("u", "w", "c", "legacy:one", "edited", "user"), "applied")
        self.assertEqual([r["body"] for r in self.history("legacy:one")], ["original", "edited"])

    def test_retrieval_isolation_reconcile_and_budget(self):
        self.put("quartz user one")
        self.put("quartz other user", user="other")
        self.put("quartz other world", user="third", world="other")
        found = self.store.recall("u", "w", "c", "quartz", max_chars=64)
        self.assertEqual(len(found), 1)
        self.assertEqual(found[0]["text"], "quartz user one")
        self.store.reconcile("u", "c", [], "all")
        self.assertEqual(self.store.recall("u", "w", "c", "quartz"), [])
        self.assertEqual(self.store.connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_exact_chat_world_user_isolation(self):
        for user, chat, text in [("u", "c", "one"), ("u", "c2", "two"), ("u2", "c", "three")]:
            self.put(text, user=user, chat=chat)
        self.assertEqual(self.item()["body"], "one")
        self.assertEqual(self.item(chat="c2")["body"], "two")
        self.assertEqual(self.item(user="u2")["body"], "three")
        self.assertIsNone(self.item(world="other"))
        self.assertIsNone(self.item(chat="missing"))
        with self.assertRaises((TypeError, ValueError)):
            self.store.get_item("u", "w", "s")

    def test_reconcile_retains_latest_and_versions_for_live_archive_all(self):
        self.put("old raw")
        self.put("new raw", 2)
        self.put("archive raw", source="legacy:one")
        self.assertEqual(self.store.reconcile("u", "c", [], "live"), 1)
        self.assertIsNone(self.item())
        row = self.store.connection.execute(
            """SELECT
                   body,
                   active
               FROM
                   memory
               WHERE
                   user_scope = ?
                   AND chat = ?
                   AND source = ?""", ("u", "c", "s")).fetchone()
        self.assertEqual(tuple(row), ("new raw", 0))
        self.assertEqual([r["body"] for r in self.history()], ["old raw", "new raw"])
        self.assertEqual(self.store.reconcile("u", "c", [], "all"), 1)
        self.assertEqual(self.history("legacy:one")[0]["body"], "archive raw")
        with self.assertRaises(ValueError):
            self.put("different", 2)
        self.assertEqual(self.put("new raw", 2)["status"], "stored")
        self.assertEqual(self.item()["body"], "new raw")

    def test_reconcile_archive_mode_preserves_live(self):
        self.put("live")
        self.put("archive", source="legacy:one")
        self.assertEqual(self.store.reconcile("u", "c", [], "archive"), 1)
        self.assertEqual(self.item()["body"], "live")
        self.assertEqual(self.history("legacy:one")[0]["body"], "archive")

    def test_recall_tail_evidence_is_bounded_but_canonical_full(self):
        text = "x " * 100000 + "unique tail quartzmarker evidence"
        self.put(text)
        lengths = []
        original = memory_store.terms_for
        def measured(value):
            lengths.append(len(value))
            return original(value)
        with patch.object(memory_store, "terms_for", measured):
            found = self.store.recall("u", "w", "c", "quartzmarker", max_chars=1000)
        self.assertTrue(found)
        self.assertIn("quartzmarker", found[0]["text"])
        self.assertEqual(found[0]["full_length"], len(text))
        self.assertLessEqual(max(lengths), 12000)
        self.assertEqual(self.item()["body"], text)

    def test_migration_fresh_idempotent(self):
        self.assertEqual(self.store.connection.execute("PRAGMA user_version").fetchone()[0], 3)
        self.put()
        self.store.close()
        self.store = MemoryStore(self.path)
        self.assertEqual(len(self.history()), 1)

    def test_migration_v02_fixture_keeps_data_archive_state_and_hashes(self):
        self.store.close()
        old = sqlite3.connect(self.path)
        old.executescript("""
            DROP TABLE IF EXISTS memory;
            DROP TABLE IF EXISTS memory_version;
            CREATE TABLE memory (
                user_scope TEXT NOT NULL, world TEXT NOT NULL, chat TEXT NOT NULL,
                source TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL,
                role TEXT NOT NULL, active INTEGER NOT NULL, updated_at INTEGER NOT NULL,
                PRIMARY KEY (user_scope, chat, source)
            );
            PRAGMA user_version = 2;
        """)
        original = "retained from v0.2 世界"
        old.execute("""INSERT INTO
                          memory (user_scope, world, chat, source, revision, body, role, active, updated_at)
                      VALUES
                          (?, ?, ?, ?, ?, ?, ?, ?, ?)""", ("u", "w", "c", "s", 7, original, "user", 1, 123))
        old.execute("""INSERT INTO
                          archive_state (user_scope, world, card, chat, stamp, source_count, completed_at)
                      VALUES
                          (?, ?, ?, ?, ?, ?, ?)""", ("u", "w", "card", "c", "stamp", 1, 123))
        old.commit()
        old.close()
        self.store = MemoryStore(self.path)
        self.assertEqual(self.item()["body"], original)
        self.assertEqual(self.item()["sha256"], digest(original))
        self.assertEqual(tuple(self.history()[0]), (7, original, digest(original)))
        self.assertEqual(self.store.archive_states("u", "w", "card")["c"]["stamp"], "stamp")
        self.assertEqual(self.store.connection.execute("PRAGMA user_version").fetchone()[0], 3)


if __name__ == "__main__":
    unittest.main()
