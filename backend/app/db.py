"""显式保存 UI 消息和结构化卡片；每次调用按会话重建模型上下文。"""
import json
import sqlite3
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

def uid() -> str:
    return uuid.uuid4().hex

def now() -> str:
    return datetime.now(timezone.utc).isoformat()

def dump(value) -> str:
    return json.dumps(value, ensure_ascii=False)

class Database:
    def __init__(self, path: Path):
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as c:
            c.executescript('''
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS conversations(
                id TEXT PRIMARY KEY,title TEXT NOT NULL,created_at TEXT,updated_at TEXT,context TEXT DEFAULT '{}');
            CREATE TABLE IF NOT EXISTS messages(
                id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
                request_id TEXT,role TEXT,content TEXT DEFAULT '',cards TEXT DEFAULT '[]',
                image_id TEXT,status TEXT DEFAULT 'complete',created_at TEXT,
                UNIQUE(conversation_id,request_id,role));
            CREATE TABLE IF NOT EXISTS images(
                id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
                object_key TEXT,created_at TEXT,expires_at TEXT,status TEXT DEFAULT 'active');
            CREATE TABLE IF NOT EXISTS profile(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS plans(
                id TEXT PRIMARY KEY,family_id TEXT,version INTEGER,data TEXT,created_at TEXT,
                source_key TEXT UNIQUE,UNIQUE(family_id,version));
            ''')
            c.execute("UPDATE messages SET status='interrupted' WHERE status='streaming'")

    @contextmanager
    def connect(self):
        c = sqlite3.connect(self.path, timeout=10)
        try:
            c.row_factory = sqlite3.Row
            c.execute('PRAGMA foreign_keys=ON')
            with c:
                yield c
        finally:
            c.close()

    @staticmethod
    def decode(row):
        if row is None:
            return None
        data = dict(row)
        for k in ('context', 'cards', 'data'):
            if k in data:
                data[k] = json.loads(data[k])
        return data

    def create_conversation(self):
        id_, ts = uid(), now()
        with self.connect() as c:
            c.execute('INSERT INTO conversations(id,title,created_at,updated_at) VALUES(?,?,?,?)',
                      (id_, '新对话', ts, ts))
        return self.conversation(id_)

    def conversations(self):
        with self.connect() as c:
            return [self.decode(x) for x in c.execute('SELECT * FROM conversations ORDER BY updated_at DESC')]

    def conversation(self, id_):
        with self.connect() as c:
            return self.decode(c.execute('SELECT * FROM conversations WHERE id=?', (id_,)).fetchone())

    def rename(self, id_, title):
        with self.connect() as c:
            c.execute('UPDATE conversations SET title=?,updated_at=? WHERE id=?', (title, now(), id_))

    def context(self, id_, **values):
        with self.connect() as c:
            row = c.execute('SELECT context FROM conversations WHERE id=?', (id_,)).fetchone()
            state = json.loads(row['context'])
            state.update(values)
            c.execute('UPDATE conversations SET context=?,updated_at=? WHERE id=?', (dump(state), now(), id_))
        return state

    def messages(self, id_):
        with self.connect() as c:
            return [self.decode(r) for r in c.execute('SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid', (id_,))]

    def message(self, id_):
        with self.connect() as c:
            return self.decode(c.execute('SELECT * FROM messages WHERE id=?', (id_,)).fetchone())

    def turn(self, conversation_id, request_id):
        with self.connect() as c:
            return [self.decode(r) for r in c.execute('SELECT * FROM messages WHERE conversation_id=? AND request_id=? ORDER BY rowid', (conversation_id, request_id))]

    def add_message(self, conversation_id, request_id, role, content='', cards=None, image_id=None, status='complete'):
        id_ = uid()
        with self.connect() as c:
            c.execute('INSERT INTO messages(id,conversation_id,request_id,role,content,cards,image_id,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
                      (id_, conversation_id, request_id, role, content, dump(cards or []), image_id, status, now()))
            c.execute('UPDATE conversations SET updated_at=? WHERE id=?', (now(), conversation_id))
        return self.message(id_)

    def update_message(self, id_, content, cards, status):
        with self.connect() as c:
            c.execute('UPDATE messages SET content=?,cards=?,status=? WHERE id=?', (content, dump(cards), status, id_))

    def profile(self):
        with self.connect() as c:
            r = c.execute('SELECT data FROM profile WHERE id=1').fetchone()
            return json.loads(r['data']) if r else {}

    def save_profile(self, data):
        with self.connect() as c:
            c.execute('INSERT INTO profile(id,data) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data', (dump(data),))

    def add_image(self, id_, conversation_id, key, expires):
        with self.connect() as c:
            c.execute('INSERT INTO images VALUES(?,?,?,?,?,?)', (id_, conversation_id, key, now(), expires, 'active'))

    def image(self, id_):
        with self.connect() as c:
            r = c.execute('SELECT * FROM images WHERE id=?', (id_,)).fetchone()
            return dict(r) if r else None

    def images(self, conversation_id=None, expired=False):
        sql, params = "SELECT * FROM images WHERE status='active'", []
        if conversation_id:
            sql += ' AND conversation_id=?'
            params.append(conversation_id)
        if expired:
            sql += ' AND expires_at<=?'
            params.append(now())
        with self.connect() as c:
            return [dict(x) for x in c.execute(sql, params)]

    def remove_image(self, id_, status='deleted'):
        with self.connect() as c:
            c.execute('UPDATE images SET status=? WHERE id=?', (status, id_))
            for message in c.execute('SELECT id,cards FROM messages WHERE image_id=?', (id_,)).fetchall():
                cards = json.loads(message['cards'])
                cards.append({'type': 'image_removed', 'status': status})
                c.execute('UPDATE messages SET image_id=NULL,cards=? WHERE id=?', (dump(cards), message['id']))

    def delete_conversation(self, id_):
        with self.connect() as c:
            c.execute('DELETE FROM conversations WHERE id=?', (id_,))

    def save_plan(self, data, source_key, parent_id=None):
        with self.connect() as c:
            c.execute('BEGIN IMMEDIATE')
            old = c.execute('SELECT * FROM plans WHERE source_key=?', (source_key,)).fetchone()
            if old:
                return self.decode(old)
            parent = c.execute('SELECT * FROM plans WHERE id=?', (parent_id,)).fetchone() if parent_id else None
            id_ = uid()
            family = parent['family_id'] if parent else id_
            version = c.execute('SELECT COALESCE(MAX(version),0)+1 FROM plans WHERE family_id=?', (family,)).fetchone()[0]
            c.execute('INSERT INTO plans VALUES(?,?,?,?,?,?)', (id_, family, version, dump(data), now(), source_key))
            return self.decode(c.execute('SELECT * FROM plans WHERE id=?', (id_,)).fetchone())

    def plans(self):
        with self.connect() as c:
            return [self.decode(x) for x in c.execute('SELECT * FROM plans ORDER BY created_at DESC')]

    def plan(self, id_):
        with self.connect() as c:
            return self.decode(c.execute('SELECT * FROM plans WHERE id=?', (id_,)).fetchone())

    def delete_plan(self, id_):
        with self.connect() as c:
            c.execute('DELETE FROM plans WHERE id=?', (id_,))
