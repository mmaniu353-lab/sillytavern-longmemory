import copy
import hashlib
import importlib.util
import json
import sqlite3
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'plugin'))


def document(raw='世界 🌎\nStraße\nneedle', ident='doc'):
    return dict(id=ident, title='原文标题', format='json', raw=raw,
                sha256=hashlib.sha256(raw.encode('utf-8')).hexdigest(),
                messages=[dict(id='m1', role='user', text=raw, meta={'nested': ['原始', 2]})],
                warnings=['原样保留'], parserRevision='threadshelf-1')


class VaultFixture:

    def setUp(self):
        self.assertIsNotNone(importlib.util.find_spec('vault_store'), 'canonical VaultStore implementation is missing')
        import vault_store
        self.module = vault_store
        self.connection = sqlite3.connect(':memory:')
        self.vault = vault_store.VaultStore(self.connection)

    def tearDown(self):
        if hasattr(self, 'connection'):
            self.connection.close()

    def add(self, docs, user='alice', world='world', collection='default'):
        return self.vault.import_documents(user, world, collection, docs)


class VaultTests(VaultFixture, unittest.TestCase):
    def test_unicode_full_roundtrip_and_current_history(self):
        first, second = document(), document('第二版\n' + '長' * 7000)
        self.assertEqual(self.add([first]), {'imported': 1, 'unchanged': 0})
        self.assertEqual(self.add([second]), {'imported': 1, 'unchanged': 0})
        exported = self.vault.export_vault('alice', 'world', 'default')
        self.assertEqual(exported['schemaVersion'], 1)
        self.assertEqual(len(exported['documents']), 2)
        for entry in exported['documents']:
            original = second if entry['current'] else first
            self.assertEqual({k: entry[k] for k in original}, original)
        target = self.module.VaultStore(sqlite3.connect(':memory:'))
        try:
            target.import_documents('alice', 'world', 'default', exported['documents'])
            self.assertEqual(target.export_vault('alice', 'world', 'default'), exported)
        finally:
            target.connection.close()

    def test_idempotence_and_projection_revision(self):
        source = document()
        self.add([source])
        self.assertEqual(self.add([source]), {'imported': 0, 'unchanged': 1})
        changed = copy.deepcopy(source)
        changed['messages'][0]['text'] = 'corrected projection'
        self.add([changed])
        records = self.vault.export_vault('alice', 'world', 'default')['documents']
        self.assertEqual(len(records), 2)
        self.assertEqual(len({record['revision'] for record in records}), 2)
        self.assertEqual(sum(record['current'] for record in records), 1)

    def test_hash_mismatch_and_bad_batches_are_atomic(self):
        bad = document('bad', 'second')
        bad['sha256'] = '0' * 64
        with self.assertRaises(ValueError):
            self.add([document(), bad])
        self.assertEqual(self.vault.list_vault('alice', 'world', 'default'), [])

    def test_scope_and_cross_user_search(self):
        self.add([document('private needle')])
        self.add([document('other-world needle')], world='other')
        self.add([document('other-user needle')], user='bob')
        self.add([document('other-collection needle')], collection='other')
        found = self.vault.search_vault('alice', 'world', 'needle')
        self.assertEqual([hit['text'] for hit in found], ['private needle'])
        self.assertEqual(self.vault.search_vault('nobody', 'world', 'needle'), [])
        self.assertIsNone(self.vault.read_vault_item('nobody', 'world', 'default', 'doc', 'm1'))

    def test_search_offsets_unicode_and_rebuild(self):
        text = '前' * 3100 + 'Straße NEEDLE' + '後' * 3100
        self.add([document(text)])
        for query, mode in [('strasse needle', 'keyword'), ('STRASSE NEEDLE', 'exact')]:
            found = self.vault.search_vault('alice', 'world', query, max_chars=500, mode=mode)
            self.assertTrue(found)
            self.assertLessEqual(sum(len(hit['text']) for hit in found), 500)
            hit = found[0]
            full = self.vault.read_vault_item('alice', 'world', 'default', hit['documentId'], hit['messageId'], hit['revision'])
            self.assertEqual(full['text'][hit['offset']:hit['offset'] + len(hit['text'])], hit['text'])
            self.assertEqual(full['text'], text)
            self.assertEqual(hit['kind'], 'knowledge')
        self.assertEqual(self.vault.search_vault('alice', 'world', 'absent needle'), [])
        self.connection.execute('DELETE FROM vault_chunks')
        self.connection.commit()
        self.vault.rebuild_index('alice')
        self.assertTrue(self.vault.search_vault('alice', 'world', 'needle'))

    def test_list_is_bounded_summary_not_canonical_text(self):
        source = document('z' * 20000)
        self.add([source])
        rows = self.vault.list_vault('alice', 'world', 'default')
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['messageCount'], 1)
        self.assertEqual(rows[0]['rawBytes'], 20000)
        self.assertNotIn('raw', rows[0])
        self.assertNotIn('messages', rows[0])
        self.assertLessEqual(len(rows[0]['preview']), 240)

    def test_bad_input_duplicate_ids_and_forged_scope(self):
        invalid = []
        for update in [dict(id=''), dict(user_scope='bob'), dict(world='other'), dict(raw='\ud800'),
                       dict(warnings='not-list'), dict(messages=[dict(id='m', role='bad', text='x')])]:
            value = document()
            value.update(update)
            invalid.append([value])
        dup = document()
        dup['messages'].append(copy.deepcopy(dup['messages'][0]))
        invalid.extend([[dup], [document(), document()]])
        huge = document()
        huge['messages'][0]['text'] = '界' * (1024 * 1024 // 3 + 1)
        invalid.append([huge])
        for batch in invalid:
            with self.subTest(batch=str(batch)[:70]), self.assertRaises(ValueError):
                self.add(batch)
        with self.assertRaises(ValueError):
            self.add([document()], collection='../outside')
        self.assertEqual(self.vault.list_vault('alice', 'world', 'default'), [])

    def test_quota_counts_retained_versions_and_batch_messages(self):
        self.vault.MAX_TOTAL_BYTES = 1200
        first, second = document('12345'), document('123456')
        del first['messages'][0]['meta']
        del second['messages'][0]['meta']
        self.add([first])
        self.add([second])
        with self.assertRaises(ValueError):
            self.add([document('1234567' * 100)])
        self.assertEqual(len(self.vault.export_vault('alice', 'world', 'default')['documents']), 2)
        self.vault.MAX_MESSAGES = 1
        batch = document('x', 'other')
        batch['messages'].append(dict(id='m2', role='note', text='y'))
        with self.assertRaises(ValueError):
            self.add([batch])

class VaultEdgeTests(VaultFixture, unittest.TestCase):
    def test_keyword_terms_can_span_distinct_chunks(self):
        self.add([document('alpha ' + 'x' * 6500 + ' omega')])
        found = self.vault.search_vault('alice', 'world', 'alpha omega')
        self.assertTrue(found)
        self.assertEqual(found[0]['messageId'], 'm1')

    def test_exact_crosses_chunk_boundary_casefold_expansion(self):
        phrase = 'ß' * 500 + 'needle'
        self.add([document('a' * 1450 + phrase + 'b' * 2000)])
        found = self.vault.search_vault('alice', 'world', 'ss' * 250 + 'needle', mode='exact')
        self.assertTrue(found)

    def test_keyword_term_casefold_growth_can_cross_chunk_boundary(self):
        source = document('x' * 1450 + 'ß' * 512 + 'y' * 2000)
        self.add([source])
        self.assertTrue(self.vault.search_vault('alice', 'world', 'ß' * 512))

    def test_search_can_return_distinct_messages_after_repeated_matches(self):
        source = document('needle ' * 5000)
        source['messages'].append(dict(id='m2', role='assistant', text='needle second'))
        self.add([source])
        found = self.vault.search_vault('alice', 'world', 'needle', limit=2)
        self.assertEqual({hit['messageId'] for hit in found}, {'m1', 'm2'})

    def test_import_rejects_payload_quota_before_normalizing_later_entries(self):
        self.vault.MAX_TOTAL_BYTES = 30
        with self.assertRaises(ValueError):
            self.add([document('x' * 31), None])
        self.assertEqual(self.vault.list_vault('alice', 'world'), [])

    def test_keyword_long_term_with_casefold_expansion_crosses_overlap(self):
        self.add([document('x' * 1490 + 'ß' * 512 + 'y' * 2000)])
        self.assertTrue(self.vault.search_vault('alice', 'world', 'ß' * 512))

    def test_embedded_nul_retains_search_offsets_after_rebuild(self):
        source = document('prefix\x00' + '長' * 3000 + ' needle')
        self.add([source])
        before = self.vault.search_vault('alice', 'world', 'needle')
        self.assertTrue(before)
        self.vault.rebuild_index('alice')
        self.assertEqual(self.vault.search_vault('alice', 'world', 'needle'), before)
        rows = self.vault.list_vault('alice', 'world')
        self.assertEqual(rows[0]['rawChars'], len(source['raw']))

    def test_export_quota_combines_raw_projection_escaping_and_warnings(self):
        self.vault.MAX_TOTAL_BYTES = 1000
        cases = [document('x' * 900), document('\x00' * 100), document('x')]
        cases[-1]['warnings'] = ['w' * 1000]
        for source in cases:
            with self.subTest(raw=source['raw'][:8]), self.assertRaises(ValueError):
                self.add([source])
            self.assertEqual(self.vault.list_vault('alice', 'world'), [])

    def test_export_quota_boundary_reimport_and_retained_versions_across_scope(self):
        first, second = document('first'), document('second')
        self.add([first])
        self.add([second])
        exported = self.vault.export_vault('alice', 'world')
        size = len(json.dumps(exported, ensure_ascii=False, allow_nan=False).encode('utf-8'))
        target = self.module.VaultStore(sqlite3.connect(':memory:'))
        target.MAX_TOTAL_BYTES = size
        try:
            target.import_documents('alice', 'world', 'default', exported['documents'])
            self.assertEqual(target.export_vault('alice', 'world'), exported)
            self.assertEqual(target.import_documents('alice', 'world', 'default', exported['documents']),
                             {'imported': 0, 'unchanged': 2})
            for scope in [('alice', 'other', 'default'), ('alice', 'world', 'other')]:
                with self.subTest(scope=scope), self.assertRaises(ValueError):
                    target.import_documents(*scope, [document('extra')])
                self.assertEqual(target.list_vault(*scope), [])
            target.import_documents('bob', 'world', 'default', [document('separate-user')])
        finally:
            target.connection.close()
        smaller = self.module.VaultStore(sqlite3.connect(':memory:'))
        smaller.MAX_TOTAL_BYTES = size - 1
        try:
            with self.assertRaises(ValueError):
                smaller.import_documents('alice', 'world', 'default', exported['documents'])
            self.assertEqual(smaller.list_vault('alice', 'world'), [])
        finally:
            smaller.connection.close()

    def test_incremental_input_quota_stops_before_later_documents(self):
        self.vault.MAX_TOTAL_BYTES = 1000
        original = self.vault._normalize
        visited = []
        def track(source):
            visited.append(source['id'])
            return original(source)
        self.vault._normalize = track
        with self.assertRaises(ValueError):
            self.add([document('x' * 900, 'large'), document('y', 'later')])
        self.assertEqual(visited, ['large'])

    def test_retained_document_revision_limit_and_empty_projection(self):
        self.vault.MAX_MESSAGES = 2
        self.add([document('first')])
        self.add([document('second')])
        with self.assertRaises(ValueError):
            self.add([document('third')])
        empty = document('empty', 'empty')
        empty['messages'] = []
        with self.assertRaises(ValueError):
            self.add([empty], user='other')
        exported = self.vault.export_vault('alice', 'world')
        target = self.module.VaultStore(sqlite3.connect(':memory:'))
        target.MAX_MESSAGES = 2
        try:
            target.import_documents('alice', 'world', 'default', exported['documents'])
            self.assertEqual(target.export_vault('alice', 'world'), exported)
        finally:
            target.connection.close()

    def test_incremental_message_limit_stops_before_later_documents(self):
        self.vault.MAX_MESSAGES = 2
        source = document('first')
        source['messages'].append(dict(id='m2', role='note', text='other'))
        original = self.vault._normalize
        visited = []
        def track(item):
            visited.append(item['id'])
            return original(item)
        self.vault._normalize = track
        with self.assertRaises(ValueError):
            self.add([source, document('second', 'second'), document('third', 'third')])
        self.assertEqual(visited, ['doc', 'second'])

    def test_retained_export_check_rolls_back_after_tentative_revision_insert(self):
        source = document('first')
        self.add([source])
        before = self.vault.export_vault('alice', 'world')
        self.vault.MAX_TOTAL_BYTES = len(json.dumps(before, ensure_ascii=False).encode('utf-8')) + 10
        with self.assertRaisesRegex(ValueError, 'retained canonical export'):
            self.add([document('second')])
        self.assertEqual(self.vault.export_vault('alice', 'world'), before)

    def test_three_document_payload_over_limit_rolls_back(self):
        self.vault.MAX_MESSAGES = 2
        original = self.vault._normalize
        visited = []
        def track(item):
            visited.append(item['id'])
            return original(item)
        self.vault._normalize = track
        with self.assertRaises(ValueError):
            self.add([document('one', 'one'), document('two', 'two'), document('three', 'three')])
        self.assertEqual(visited, ['one', 'two', 'three'])
        self.assertEqual(self.vault.list_vault('alice', 'world'), [])

    def test_invalid_role_type_is_value_error(self):
        bad = document()
        bad['messages'][0]['role'] = ['user']
        with self.assertRaises(ValueError):
            self.add([bad])

    def test_canonical_message_count_is_aggregate_not_only_batch(self):
        self.vault.MAX_MESSAGES = 1
        self.add([document('one')])
        with self.assertRaises(ValueError):
            self.add([document('two', 'second')])

    def test_projection_growth_counts_against_canonical_quota(self):
        self.vault.MAX_TOTAL_BYTES = 300
        source = document('x')
        source['messages'][0]['text'] = 'y' * 400
        with self.assertRaises(ValueError):
            self.add([source])


if __name__ == '__main__':
    unittest.main()
