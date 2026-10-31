"""
Один модуль: парсинг KB + FAQ + FTS5 + граф + роутер.
Работает с ОДНИМ файлом, где есть "articles" и (опционально) "faq".
"""
import json
import os
import re
import sqlite3
from difflib import SequenceMatcher
from typing import Optional

def _clean(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^a-zа-яё0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s)

class Engine:
    def __init__(self, raw: dict, gemini_key: str = ""):
        self.game = raw.get("game", "game")
        self.aka = raw.get("aka", [])
        self.articles: dict = {}
        for a in raw.get("articles", []):
            self.articles[a["id"]] = a
        self.faq: list = raw.get("faq", [])
        self._build_fts()
        self._build_faq_index()
        self._gemini_key = gemini_key

    # ── FTS5 (in-memory) ──
    def _build_fts(self):
        self.db = sqlite3.connect(":memory:", check_same_thread=False)
        self.db.execute(
            "CREATE VIRTUAL TABLE docs USING fts5(doc_id UNINDEXED, body,"
            " tokenize='unicode61 remove_diacritics 2')"
        )
        for aid, a in self.articles.items():
            facts = " ".join(
                (f.get("text", "") if isinstance(f, dict) else str(f))
                for f in a.get("facts", [])
            )
            body = " ".join([
                a.get("title",""), a.get("summary",""),
                a.get("quick_answer",""), a.get("voice_answer",""),
                " ".join(a.get("questions",[])), " ".join(a.get("tags",[])),
                " ".join(a.get("aka",[])), facts,
            ])
            self.db.execute("INSERT INTO docs(doc_id, body) VALUES (?,?)", (aid, body))
        self.db.commit()

    def fts_search(self, q: str, limit: int = 5) -> list:
        words = [w for w in _clean(q).split() if len(w) > 1]
        if not words:
            return []
        match = " OR ".join(words)
        try:
            cur = self.db.execute(
                "SELECT doc_id, bm25(docs) s FROM docs WHERE docs MATCH ? "
                "ORDER BY s LIMIT ?", (match, limit))
            rows = cur.fetchall()
        except sqlite3.OperationalError:
            return []
        if not rows:
            return []
        mn = min(r[1] for r in rows); mx = max(r[1] for r in rows)
        rng = mx - mn if mx != mn else 1.0
        return [(r[0], (r[1]-mn)/rng) for r in rows]

    # ── FAQ index ──
    def _build_faq_index(self):
        self._f_norm_q = {}
        self._f_norm_a = {}
        for e in self.faq:
            self._f_norm_q[_clean(e.get("question",""))] = e
            for al in e.get("aliases", []):
                self._f_norm_a[_clean(al)] = e

    def faq_exact(self, q: str) -> Optional[dict]:
        nq = _clean(q)
        return self._f_norm_q.get(nq) or self._f_norm_a.get(nq)

    def faq_fuzzy(self, q: str, th: float = 0.84):
        nq = _clean(q)
        best, bs = None, 0.0
        for e in self.faq:
            s = max(
                SequenceMatcher(None, nq, _clean(e.get("question",""))).ratio(),
                max((SequenceMatcher(None, nq, _clean(al)).ratio() for al in e.get("aliases",[])), default=0.0),
            )
            if s > bs:
                bs, best = s, e
        return (best, bs) if (best and bs >= th) else None

    # ── Собираем ответ из статьи ──
    def _from_article(self, a: dict, force_voice: str = "") -> dict:
        quick = a.get("quick_answer") or a.get("summary","")
        voice = force_voice or a.get("voice_answer") or quick[:120]
        card = a.get("overlay_card")
        if not card:
            card = {
                "type":"answer","title":a.get("title",""),
                "short":quick[:80],
                "bullets":[(f.get("text","") if isinstance(f,dict) else str(f))[:60]
                           for f in a.get("facts",[])[:3]],
                "image":a.get("template",""),
            }
        card["related"] = [self.articles[x].get("title","")
                          for x in a.get("links",[])[:3] if x in self.articles]
        return {"answer":quick,"voice":voice,"overlay":card,"confidence":0.95,
                "used_llm":False,"sources":[a.get("id")],"follow_up":self._follow(a)}

    def _follow(self, a: dict):
        cat = a.get("category","")
        if cat == "бои": return "Показать тактику подробнее?"
        if cat == "коллекции": return "Сколько ещё осталось?"
        if cat == "трофеи": return "Показать полный список?"
        return None

    # ── Главный метод ──
    def ask(self, q: str, context: dict) -> dict:
        # L1 FAQ exact
        hit = self.faq_exact(q)
        if hit:
            return self._from_article(self.articles.get(hit.get("answer_article",{})),
                                      hit.get("voice_answer",""))
        # L1b FAQ fuzzy
        fh = self.faq_fuzzy(q)
        if fh:
            e, s = fh
            r = self._from_article(self.articles.get(e.get("answer_article",{})),
                                   e.get("voice_answer",""))
            r["confidence"] = min(r["confidence"], s)
            return r
        # L2 FTS
        hits = self.fts_search(q)
        if hits and hits[0][1] >= 0.35:
            return self._from_article(self.articles[hits[0][0]])
        # L3 Gemini
        return self._gemini(q, context, hits[:5])

    def _gemini(self, q: str, context: dict, hits: list) -> dict:
        if not self._gemini_key:
            return {"answer":"Не уверен, не нашёл в базе.",
                    "voice":"Не уверен. Попробуй иначе.","overlay":None,
                    "confidence":0.3,"used_llm":False,"sources":[],"follow_up":None}
        ctx = "\n".join(f"[{aid}] {self.articles[aid].get('title','')}\n"
                        f"{self.articles[aid].get('summary','')}" for aid,_ in hits) or "(нет)"
        try:
            import google.generativeai as genai
            genai.configure(api_key=self._gemini_key)
            m = genai.GenerativeModel(os.environ.get("LLM_MODEL", "gemini-flash-latest"))
            r = m.generate_content(
                "Ты голосовой ассистент по игре " + self.game +
                ". Ответь короче 2 предложений, без воды. Только по CONTEXT.\n"
                "CONTEXT:\n" + ctx + "\nВОПРОС: " + q,
                generation_config={"temperature":0.1,"max_output_tokens":200})
            return {"answer":r.text.strip(),"voice":r.text.strip(),
                    "overlay":None,"confidence":0.6,"used_llm":True,
                    "sources":[x for x,_ in hits],"follow_up":None}
        except Exception:
            return {"answer":"Не уверен.","voice":"Не уверен.","overlay":None,
                    "confidence":0.3,"used_llm":True,"sources":[],"follow_up":None}

def parse_kb(text: str, gemini_key: str = "") -> "Engine":
    return Engine(json.loads(text), gemini_key)
