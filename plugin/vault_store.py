from __future__ import annotations

import hashlib
import json
import re


class VaultStore:
    MAX_TOTAL_BYTES = 128 * 1024 * 1024
    MAX_DOCUMENT_BYTES = 32 * 1024 * 1024
    MAX_MESSAGE_BYTES = 1024 * 1024
    MAX_MESSAGES = 10000
    CHUNK_CHARS = 2000
    CHUNK_STEP = 1400

    def __init__(self, connection):
        self.connection = connection
        self.connection.create_function('vault_length', 1, len, deterministic=True)
        self.connection.create_function('vault_substr', 3, lambda value, start, length: value[start - 1:start - 1 + length], deterministic=True)
        self.connection.executescript('''
            CREATE TABLE IF NOT EXISTS vault_documents (
                user_scope TEXT NOT NULL,
                world TEXT NOT NULL,
                collection TEXT NOT NULL,
                document_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                current INTEGER NOT NULL,
                title TEXT NOT NULL,
                format TEXT NOT NULL,
                raw TEXT NOT NULL,
                raw_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                warnings TEXT NOT NULL,
                parser_revision TEXT,
                PRIMARY KEY (user_scope, world, collection, document_id, revision)
            );
            CREATE INDEX IF NOT EXISTS vault_document_scope
                ON vault_documents (user_scope, world, collection, current);
            CREATE TABLE IF NOT EXISTS vault_messages (
                user_scope TEXT NOT NULL,
                world TEXT NOT NULL,
                collection TEXT NOT NULL,
                document_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                message_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                role TEXT NOT NULL,
                text TEXT NOT NULL,
                meta TEXT,
                PRIMARY KEY (user_scope, world, collection, document_id, revision, message_id)
            );
            CREATE TABLE IF NOT EXISTS vault_chunks (
                user_scope TEXT NOT NULL,
                world TEXT NOT NULL,
                collection TEXT NOT NULL,
                document_id TEXT NOT NULL,
                revision TEXT NOT NULL,
                message_id TEXT NOT NULL,
                offset INTEGER NOT NULL,
                text TEXT NOT NULL,
                folded TEXT NOT NULL,
                PRIMARY KEY (user_scope, world, collection, document_id, revision, message_id, offset)
            );
            CREATE INDEX IF NOT EXISTS vault_chunk_scope
                ON vault_chunks (user_scope, world, collection, document_id, revision);
        ''')

    @staticmethod
    def _text(value, name, limit, empty=False):
        if not isinstance(value, str) or (not empty and not value) or len(value) > limit:
            raise ValueError('invalid ' + name)
        try:
            value.encode('utf-8')
        except UnicodeEncodeError as error:
            raise ValueError('invalid UTF-8 in ' + name) from error
        return value

    @classmethod
    def _scope(cls, user_scope, world, collection):
        cls._text(user_scope, 'user_scope', 240)
        cls._text(world, 'world', 240)
        if not isinstance(collection, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', collection):
            raise ValueError('invalid collection')
        return user_scope, world, collection

    @staticmethod
    def _json(value):
        try:
            encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)
            encoded.encode('utf-8')
            return encoded
        except (TypeError, ValueError, UnicodeError, RecursionError) as error:
            raise ValueError('invalid JSON metadata') from error

    @staticmethod
    def _export_bytes(value):
        try:
            return len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode('utf-8'))
        except (TypeError, ValueError, UnicodeError, RecursionError) as error:
            raise ValueError('invalid JSON export') from error

    def _normalize(self, document):
        required = {'id', 'title', 'format', 'raw', 'sha256', 'messages', 'warnings'}
        allowed = required | {'parserRevision', 'revision', 'current'}
        if not isinstance(document, dict) or not required <= document.keys() or document.keys() - allowed:
            raise ValueError('invalid document schema')
        result = {key: document[key] for key in required}
        for key, limit in [('id', 160), ('title', 240), ('format', 40)]:
            self._text(result[key], key, limit, empty=key == 'title')
        self._text(result['raw'], 'raw', self.MAX_DOCUMENT_BYTES, empty=True)
        raw_bytes = result['raw'].encode('utf-8')
        if len(raw_bytes) > self.MAX_DOCUMENT_BYTES:
            raise ValueError('raw document exceeds byte limit')
        digest = hashlib.sha256(raw_bytes).hexdigest()
        if result['sha256'] != digest:
            raise ValueError('raw sha256 mismatch')
        if not isinstance(result['warnings'], list) or len(result['warnings']) > 10000:
            raise ValueError('invalid warnings')
        input_bytes = len(raw_bytes)
        for warning in result['warnings']:
            self._text(warning, 'warning', 4096, empty=True)
            input_bytes += self._export_bytes(warning)
            if input_bytes > self.MAX_TOTAL_BYTES:
                raise ValueError('document input quota exceeded')
        if 'parserRevision' in document:
            self._text(document['parserRevision'], 'parserRevision', 160)
            result['parserRevision'] = document['parserRevision']
        messages = result['messages']
        if not isinstance(messages, list) or not 1 <= len(messages) <= self.MAX_MESSAGES:
            raise ValueError('invalid messages')
        seen = set()
        for message in messages:
            if not isinstance(message, dict) or not {'id', 'role', 'text'} <= message.keys() or message.keys() - {'id', 'role', 'text', 'meta'}:
                raise ValueError('invalid message schema')
            self._text(message['id'], 'message id', 160)
            if message['id'] in seen or not isinstance(message['role'], str) or message['role'] not in {'user', 'assistant', 'note', 'system'}:
                raise ValueError('duplicate message id or invalid role')
            seen.add(message['id'])
            self._text(message['text'], 'message text', self.MAX_MESSAGE_BYTES, empty=True)
            if len(message['text'].encode('utf-8')) > self.MAX_MESSAGE_BYTES:
                raise ValueError('message exceeds byte limit')
            if 'meta' in message and (not isinstance(message['meta'], dict) or len(self._json(message['meta']).encode('utf-8')) > 65536):
                raise ValueError('invalid message metadata')
            input_bytes += self._export_bytes(message)
            if input_bytes > self.MAX_TOTAL_BYTES:
                raise ValueError('document input quota exceeded')
        revision = hashlib.sha256(self._json(result).encode('utf-8')).hexdigest()
        if 'revision' in document and document['revision'] != revision:
            raise ValueError('projection revision mismatch')
        if 'current' in document and type(document['current']) is not bool:
            raise ValueError('invalid current flag')
        return result, revision, len(raw_bytes), document.get('current', True)

    def _chunks(self, scope, document_id, revision, message_id, value):
        for offset in range(0, len(value), self.CHUNK_STEP):
            text = value[offset:offset + self.CHUNK_CHARS]
            yield (*scope, document_id, revision, message_id, offset, text, text.casefold())
            if offset + self.CHUNK_CHARS >= len(value):
                break

    def import_documents(self, user_scope, world, collection, documents):
        scope = self._scope(user_scope, world, collection)
        if not isinstance(documents, list):
            raise ValueError('invalid documents')
        normalized, input_bytes, message_count = [], self._export_bytes({'schemaVersion': 1, 'documents': []}), 0
        for original in documents:
            item = self._normalize(original)
            document, revision, _, current = item
            input_bytes += self._export_bytes(dict(document, revision=revision, current=current)) + (2 if normalized else 0)
            message_count += len(document['messages'])
            if input_bytes > self.MAX_TOTAL_BYTES or message_count > self.MAX_MESSAGES or len(normalized) >= self.MAX_MESSAGES:
                raise ValueError('batch canonical quota exceeded')
            normalized.append(item)
        identities, groups = set(), {}
        for original, (document, revision, _, current) in zip(documents, normalized):
            key = document['id'], revision
            if key in identities or (document['id'] in groups and ('revision' not in original or not groups[document['id']]['exported'])):
                raise ValueError('duplicate document id')
            identities.add(key)
            group = groups.setdefault(document['id'], {'current': 0, 'exported': 'revision' in original})
            group['current'] += int(current)
        if any(group['current'] != 1 for group in groups.values()):
            raise ValueError('each document must have exactly one current revision')
        imported = unchanged = 0
        with self.connection:
            self.connection.execute('BEGIN IMMEDIATE')
            quota = self.connection.execute('''
                SELECT
                    COALESCE(SUM(raw_bytes), 0)
                FROM
                    vault_documents
                WHERE
                    user_scope = ?
            ''', (user_scope,)).fetchone()[0]
            projection_bytes, message_count = self.connection.execute('''
                SELECT
                    COALESCE(SUM(LENGTH(CAST(text AS BLOB)) + COALESCE(LENGTH(CAST(meta AS BLOB)), 0)), 0),
                    COUNT(message_id)
                FROM
                    vault_messages
                WHERE
                    user_scope = ?
            ''', (user_scope,)).fetchone()
            pending = []
            for document, revision, raw_bytes, current in normalized:
                exists = self.connection.execute('''
                    SELECT
                        1
                    FROM
                        vault_documents
                    WHERE
                        user_scope = ?
                        AND world = ?
                        AND collection = ?
                        AND document_id = ?
                        AND revision = ?
                ''', (*scope, document['id'], revision)).fetchone()
                if exists:
                    unchanged += 1
                else:
                    quota += raw_bytes
                    projection_bytes += sum(len(message['text'].encode('utf-8')) +
                                            (len(self._json(message['meta']).encode('utf-8')) if 'meta' in message else 0)
                                            for message in document['messages'])
                    message_count += len(document['messages'])
                    pending.append((document, revision, raw_bytes, current))
            if quota > self.MAX_TOTAL_BYTES or projection_bytes > self.MAX_TOTAL_BYTES or message_count > self.MAX_MESSAGES:
                raise ValueError('canonical quota exceeded')
            for document, revision, raw_bytes, current in pending:
                self.connection.execute('''
                    INSERT INTO vault_documents (
                        user_scope, world, collection, document_id, revision, current,
                        title, format, raw, raw_bytes, sha256, warnings, parser_revision
                    )
                    VALUES (
                        ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?
                    )
                ''', (*scope, document['id'], revision, document['title'], document['format'], document['raw'],
                      raw_bytes, document['sha256'], self._json(document['warnings']), document.get('parserRevision')))
                self.connection.executemany('''
                    INSERT INTO vault_messages (
                        user_scope, world, collection, document_id, revision,
                        message_id, ordinal, role, text, meta
                    )
                    VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                ''', ((*scope, document['id'], revision, message['id'], ordinal, message['role'], message['text'],
                       self._json(message['meta']) if 'meta' in message else None)
                      for ordinal, message in enumerate(document['messages'])))
                self.connection.executemany('''
                    INSERT INTO vault_chunks (
                        user_scope, world, collection, document_id, revision,
                        message_id, offset, text, folded
                    )
                    VALUES (
                        ?, ?, ?, ?, ?, ?, ?, ?, ?
                    )
                ''', (chunk for message in document['messages']
                      for chunk in self._chunks(scope, document['id'], revision, message['id'], message['text'])))
                imported += 1
            for document, revision, _, current in normalized:
                if current:
                    self.connection.execute('''
                        UPDATE
                            vault_documents
                        SET
                            current = (revision = ?)
                        WHERE
                            user_scope = ?
                            AND world = ?
                            AND collection = ?
                            AND document_id = ?
                    ''', (revision, *scope, document['id']))
            export_bytes, version_count = self._retained_export_size(user_scope)
            if export_bytes > self.MAX_TOTAL_BYTES or version_count > self.MAX_MESSAGES:
                raise ValueError('retained canonical export quota exceeded')
        return {'imported': imported, 'unchanged': unchanged}

    def _retained_export_size(self, user_scope):
        total = self._export_bytes({'schemaVersion': 1, 'documents': []})
        count = 0
        rows = self.connection.execute('''
            SELECT
                world,
                collection,
                document_id,
                title,
                format,
                raw,
                sha256,
                warnings,
                parser_revision,
                revision,
                current
            FROM
                vault_documents
            WHERE
                user_scope = ?
        ''', (user_scope,))
        for world, collection, doc_id, title, format, raw, sha256, warnings, parser_revision, revision, current in rows:
            item = {'id': doc_id, 'title': title, 'format': format, 'raw': raw, 'sha256': sha256,
                    'warnings': json.loads(warnings), 'revision': revision, 'current': bool(current)}
            if parser_revision is not None:
                item['parserRevision'] = parser_revision
            messages = self.connection.execute('''
                SELECT
                    message_id,
                    role,
                    text,
                    meta
                FROM
                    vault_messages
                WHERE
                    user_scope = ?
                    AND world = ?
                    AND collection = ?
                    AND document_id = ?
                    AND revision = ?
                ORDER BY
                    ordinal
            ''', (user_scope, world, collection, doc_id, revision))
            item['messages'] = []
            for message_id, role, text, meta in messages:
                message = {'id': message_id, 'role': role, 'text': text}
                if meta is not None:
                    message['meta'] = json.loads(meta)
                item['messages'].append(message)
            total += self._export_bytes(item) + (2 if count else 0)
            count += 1
            if total > self.MAX_TOTAL_BYTES or count > self.MAX_MESSAGES:
                break
        return total, count

    def list_vault(self, user_scope, world, collection='default'):
        scope = self._scope(user_scope, world, collection)
        rows = self.connection.execute('''
            SELECT
                d.document_id,
                d.title,
                d.format,
                d.revision,
                d.sha256,
                d.raw_bytes,
                vault_length(d.raw),
                vault_substr(d.raw, 1, 240),
                (SELECT COUNT(m.message_id)
                 FROM vault_messages m
                 WHERE m.user_scope = d.user_scope AND m.world = d.world
                    AND m.collection = d.collection AND m.document_id = d.document_id AND m.revision = d.revision),
                (SELECT COUNT(v.revision)
                 FROM vault_documents v
                 WHERE v.user_scope = d.user_scope AND v.world = d.world
                    AND v.collection = d.collection AND v.document_id = d.document_id)
            FROM
                vault_documents d
            WHERE
                d.user_scope = ?
                AND d.world = ?
                AND d.collection = ?
                AND d.current = 1
            ORDER BY
                d.document_id
            LIMIT
                10000
        ''', scope).fetchall()
        keys = ('documentId', 'title', 'format', 'revision', 'sha256', 'rawBytes', 'rawChars', 'preview', 'messageCount', 'versionCount')
        return [dict(zip(keys, row), collection=collection) for row in rows]

    def export_vault(self, user_scope, world, collection='default'):
        scope = self._scope(user_scope, world, collection)
        documents = []
        with self.connection:
            self.connection.execute('BEGIN')
            rows = self.connection.execute('''
                SELECT
                    document_id,
                    title,
                    format,
                    raw,
                    sha256,
                    warnings,
                    parser_revision,
                    revision,
                    current
                FROM
                    vault_documents
                WHERE
                    user_scope = ?
                    AND world = ?
                    AND collection = ?
                ORDER BY
                    document_id,
                    revision
            ''', scope)
            for row in rows:
                document = dict(zip(('id', 'title', 'format', 'raw', 'sha256', 'warnings', 'parserRevision', 'revision', 'current'), row))
                document['warnings'] = json.loads(document['warnings'])
                document['current'] = bool(document['current'])
                if document['parserRevision'] is None:
                    del document['parserRevision']
                messages = self.connection.execute('''
                    SELECT
                        message_id,
                        role,
                        text,
                        meta
                    FROM
                        vault_messages
                    WHERE
                        user_scope = ?
                        AND world = ?
                        AND collection = ?
                        AND document_id = ?
                        AND revision = ?
                    ORDER BY
                        ordinal
                ''', (*scope, document['id'], document['revision']))
                document['messages'] = []
                for message_id, role, text, meta in messages:
                    message = {'id': message_id, 'role': role, 'text': text}
                    if meta is not None:
                        message['meta'] = json.loads(meta)
                    document['messages'].append(message)
                documents.append(document)
        return {'schemaVersion': 1, 'documents': documents}

    def read_vault_item(self, user_scope, world, collection, documentId, messageId, revision=None):
        scope = self._scope(user_scope, world, collection)
        self._text(documentId, 'documentId', 160)
        self._text(messageId, 'messageId', 160)
        if revision is not None:
            self._text(revision, 'revision', 64)
        row = self.connection.execute('''
            SELECT
                m.text,
                m.role,
                m.meta,
                d.title,
                d.sha256,
                d.revision
            FROM
                vault_messages m
                JOIN vault_documents d
                    ON d.user_scope = m.user_scope AND d.world = m.world AND d.collection = m.collection
                    AND d.document_id = m.document_id AND d.revision = m.revision
            WHERE
                m.user_scope = ?
                AND m.world = ?
                AND m.collection = ?
                AND m.document_id = ?
                AND m.message_id = ?
                AND ((? IS NULL AND d.current = 1) OR d.revision = ?)
        ''', (*scope, documentId, messageId, revision, revision)).fetchone()
        if row is None:
            return None
        return {'documentId': documentId, 'messageId': messageId, 'collection': collection, 'text': row[0],
                'role': row[1], 'meta': json.loads(row[2]) if row[2] is not None else {}, 'title': row[3],
                'sha256': row[4], 'revision': row[5], 'offset': 0, 'kind': 'knowledge'}

    def search_vault(self, user_scope, world, query, collection='default', limit=12, max_chars=6000, mode='keyword'):
        scope = self._scope(user_scope, world, collection)
        self._text(query, 'query', 512)
        if mode not in {'keyword', 'exact'} or type(limit) is not int or not 1 <= limit <= 100:
            raise ValueError('invalid search options')
        if type(max_chars) is not int or not 1 <= max_chars <= 24000:
            raise ValueError('invalid search character budget')
        terms = [query.casefold()] if mode == 'exact' else query.casefold().split()
        if not terms or len(terms) > 32:
            return []
        clauses = '\n                AND '.join('''EXISTS (
                    SELECT
                        1
                    FROM
                        vault_chunks t
                    WHERE
                        t.user_scope = c.user_scope
                        AND t.world = c.world
                        AND t.collection = c.collection
                        AND t.document_id = c.document_id
                        AND t.revision = c.revision
                        AND t.message_id = c.message_id
                        AND INSTR(t.folded, ?) > 0
                )''' for _ in terms)
        seed = max(terms, key=len)

        rows = self.connection.execute('''
            SELECT
                c.document_id,
                c.message_id,
                c.revision,
                d.sha256,
                d.title,
                c.text,
                c.offset
            FROM
                vault_chunks c
                JOIN vault_documents d
                    ON d.user_scope = c.user_scope AND d.world = c.world AND d.collection = c.collection
                    AND d.document_id = c.document_id AND d.revision = c.revision
            WHERE
                c.user_scope = ?
                AND c.world = ?
                AND c.collection = ?
                AND d.current = 1
                AND INSTR(c.folded, ?) > 0
                AND ''' + clauses + '''
            GROUP BY
                c.document_id,
                c.message_id,
                c.revision
            HAVING
                c.offset = MIN(c.offset)
            ORDER BY
                c.document_id,
                c.message_id,
                c.offset
            LIMIT
                ?
        ''', (*scope, seed, *terms, min(limit * 8, 800)))
        found, seen, budget = [], set(), max_chars
        for document_id, message_id, revision, sha256, title, text, offset in rows:
            if (document_id, message_id) in seen:
                continue
            folded = text.casefold()
            positions = [folded.find(term) for term in terms if term in folded]
            folded_start = min(positions)
            original_start = 0
            folded_length = 0
            for index, char in enumerate(text):
                if folded_length >= folded_start:
                    original_start = index
                    break
                folded_length += len(char.casefold())
            start = max(0, original_start - min(120, budget // 4))
            snippet = text[start:start + min(budget, self.CHUNK_CHARS)]
            found.append({'documentId': document_id, 'messageId': message_id, 'revision': revision,
                          'sha256': sha256, 'title': title, 'collection': collection, 'text': snippet,
                          'offset': offset + start, 'kind': 'knowledge', 'score': float(len(terms))})
            seen.add((document_id, message_id))
            budget -= len(snippet)
            if len(found) >= limit or budget <= 0:
                break
        return found

    def rebuild_index(self, user_scope, world=None, collection=None):
        self._text(user_scope, 'user_scope', 240)
        clauses, params = ['user_scope = ?'], [user_scope]
        if world is not None:
            self._text(world, 'world', 240)
            clauses.append('world = ?')
            params.append(world)
        if collection is not None:
            self._scope(user_scope, world or '_', collection)
            clauses.append('collection = ?')
            params.append(collection)
        where = '\n                AND '.join(clauses)
        count = 0
        with self.connection:
            self.connection.execute('BEGIN IMMEDIATE')
            self.connection.execute('''
                DELETE FROM
                    vault_chunks
                WHERE
                    ''' + where, params)
            rows = self.connection.execute('''
                SELECT
                    user_scope,
                    world,
                    collection,
                    document_id,
                    revision,
                    message_id,
                    vault_length(text)
                FROM
                    vault_messages
                WHERE
                    ''' + where, params)
            for owner, item_world, item_collection, doc_id, revision, message_id, length in rows:
                for offset in range(0, length, self.CHUNK_STEP):
                    text = self.connection.execute('''
                        SELECT
                            vault_substr(text, ?, ?)
                        FROM
                            vault_messages
                        WHERE
                            user_scope = ?
                            AND world = ?
                            AND collection = ?
                            AND document_id = ?
                            AND revision = ?
                            AND message_id = ?
                    ''', (offset + 1, self.CHUNK_CHARS, owner, item_world, item_collection, doc_id, revision, message_id)).fetchone()[0]
                    self.connection.executemany('''
                        INSERT INTO vault_chunks (
                            user_scope, world, collection, document_id, revision,
                            message_id, offset, text, folded
                        )
                        VALUES (
                            ?, ?, ?, ?, ?, ?, ?, ?, ?
                        )
                    ''', [(owner, item_world, item_collection, doc_id, revision, message_id, offset, text, text.casefold())])
                    count += 1
                    if offset + self.CHUNK_CHARS >= length:
                        break
        return {'chunks': count}
