"""
SQLite FTS5: полнотекстовый поиск по KB.
Локально, <50ms, без внешних зависимостей.
"""
import sqlite3
import re
import os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kb.loader import Article

SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(
    doc_id UNINDEXED,
    title,
    summary,
    quick_answer,
    voice_answer,
    questions,
    tags,
    aka,
    facts,
    tokenize='unicode61 remove_diacritics 2'
);
"""

class FTSIndex:
    def __init__(self, db_path: str = ":memory:"):
        self.db_path = db_path
        if db_path == ":memory:":
            self.db = sqlite3.connect(":memory:", check_same_thread=False)
        else:
            self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.executescript(SCHEMA)
        self.db.commit()

    def rebuild(self, articles: dict[str, "Article"]):
        cur = self.db.cursor()
        cur.execute("DELETE FROM docs")
        for a in articles.values():
            facts_text = " ".join(
                f.get("text", "") if isinstance(f, dict) else str(f)
                for f in a.facts
            )
            row = (
                a.id,
                a.title,
                a.summary,
                a.quick_answer,
                a.voice_answer,
                " ".join(a.questions),
                " ".join(a.tags),
                " ".join(a.aka),
                facts_text,
            )
            cur.execute(
                "INSERT INTO docs(doc_id, title, summary, quick_answer, "
                "voice_answer, questions, tags, aka, facts) VALUES (?,?,?,?,?,?,?,?,?)",
                row,
            )
        self.db.commit()

    def search(self, query: str, limit: int = 10) -> list[tuple[str, float]]:
        q = re.sub(r"[^\w\s]", " ", query.lower())
        q = " ".join(q.split())
        if not q:
            return []

        cur = self.db.cursor()
        try:
            cur.execute(
                "SELECT doc_id, bm25(docs) AS score "
                "FROM docs WHERE docs MATCH ? "
                "ORDER BY score LIMIT ?",
                (q, limit),
            )
        except sqlite3.OperationalError:
            return []

        rows = cur.fetchall()
        if not rows:
            return []

        min_score = min(r[1] for r in rows)
        max_score = max(r[1] for r in rows)
        range_ = max_score - min_score if max_score != min_score else 1.0
        results = []
        for doc_id, raw in rows:
            norm = (raw - min_score) / range_ if range_ else 1.0
            results.append((doc_id, norm))
        return results
