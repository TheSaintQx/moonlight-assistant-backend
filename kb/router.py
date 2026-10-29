"""
Главный пайплайн: FAQ → FTS → Gemini fallback.
"""
import logging
from dataclasses import dataclass
from typing import Optional

from kb.loader import KB, Article
from kb.faq import FAQLayer
from kb.fts import FTSIndex
from kb.vectors import VectorIndex
from kb.graph import KBGraph
from llm.gemini import GeminiLLM

log = logging.getLogger(__name__)

@dataclass
class AskResult:
    answer: str
    voice: str
    overlay: Optional[dict]
    confidence: float
    used_llm: bool
    sources: list
    follow_up: Optional[str] = None

class Router:
    def __init__(self, kb, fts, vec, faq, graph, gemini):
        self.kb = kb
        self.fts = fts
        self.vec = vec
        self.faq = faq
        self.graph = graph
        self.gemini = gemini

    def ask(self, q: str, context: dict, session_id: str = "") -> AskResult:
        # L1a: FAQ exact
        hit = self.faq.exact(q)
        if hit:
            log.info("[L1] %s → %s", q, hit.get("answer_article"))
            return self._faq_result(hit)

        # L1b: FAQ fuzzy
        fh = self.faq.fuzzy(q, threshold=0.84)
        if fh:
            entry, score = fh
            log.info("[L1-fuzzy] %s → %s (%.2f)", q, entry.get("answer_article"), score)
            r = self._faq_result(entry)
            r.confidence = min(r.confidence, score)
            return r

        # L2: FTS
        fts_hits = self.fts.search(q, limit=10)
        if fts_hits:
            top_id, top_score = fts_hits[0]
            art = self.kb.get(top_id)
            if art and top_score >= 0.4:
                log.info("[L2] %s → %s (%.2f)", q, top_id, top_score)
                expanded = self.graph.expand(top_id, depth=1)
                overlay = self._build_overlay(art, expanded)
                follow_up = self._suggest_follow_up(art)
                return AskResult(
                    answer=art.get_quick_answer(),
                    voice=art.get_voice_answer(),
                    overlay=overlay,
                    confidence=min(1.0, top_score + 0.3),
                    used_llm=False,
                    sources=expanded[:3],
                    follow_up=follow_up,
                )

        # L3: Gemini
        log.info("[L3] %s", q)
        context_text = self._build_context(fts_hits[:5] if fts_hits else [])
        result = self.gemini.ask(q, context_text, self.kb.game)
        if result is None:
            return AskResult(
                answer="Не уверен, не нашёл в базе.",
                voice="Не уверен. Попробуй переформулировать.",
                overlay=None,
                confidence=0.3,
                used_llm=False,
                sources=[],
            )
        return AskResult(
            answer=result.get("answer", ""),
            voice=result.get("voice", result.get("answer", "")),
            overlay=self._build_overlay_from_llm(result),
            confidence=result.get("confidence", 0.5),
            used_llm=True,
            sources=result.get("sources", []),
        )

    def _faq_result(self, entry: dict) -> AskResult:
        art = self.kb.get(entry.get("answer_article", ""))
        if art:
            expanded = self.graph.expand(art.id, depth=1)
            overlay = self._build_overlay(art, expanded)
            follow_up = self._suggest_follow_up(art)
            return AskResult(
                answer=art.get_quick_answer(),
                voice=entry.get("voice_answer") or art.get_voice_answer(),
                overlay=overlay,
                confidence=entry.get("confidence", 0.95),
                used_llm=False,
                sources=expanded[:3],
                follow_up=follow_up,
            )
        return AskResult(
            answer=entry.get("voice_answer", entry.get("question", "")),
            voice=entry.get("voice_answer", ""),
            overlay=None,
            confidence=0.6,
            used_llm=False,
            sources=[],
        )

    def _build_overlay(self, art: Article, related: list[str]) -> dict:
        if art.overlay_card:
            card = dict(art.overlay_card)
        else:
            bullets = []
            for f in art.facts[:3]:
                text = f.get("text", "") if isinstance(f, dict) else str(f)
                bullets.append(text[:60])
            card = {
                "type": "answer",
                "title": art.title,
                "short": art.get_quick_answer()[:80],
                "bullets": bullets,
                "image": art.template or "",
            }

        related_titles = []
        for rid in related[1:4]:
            r_art = self.kb.get(rid)
            if r_art:
                related_titles.append(r_art.title)
        card["related"] = related_titles
        return card

    def _build_overlay_from_llm(self, llm_result: dict) -> dict:
        return {
            "type": "answer",
            "title": "Ответ ассистента",
            "short": llm_result.get("answer", "")[:80],
            "bullets": llm_result.get("bullets", [])[:3],
            "related": [],
            "image": "",
        }

    def _build_context(self, fts_hits: list) -> str:
        parts = []
        for doc_id, _score in fts_hits:
            art = self.kb.get(doc_id)
            if not art:
                continue
            block = f"[{art.id}] {art.title}\n{art.summary}\n"
            for f in art.facts[:4]:
                text = f.get("text", "") if isinstance(f, dict) else str(f)
                block += f"  - {text}\n"
            parts.append(block)
        return "\n".join(parts)[:3000]

    def _suggest_follow_up(self, art: Article) -> Optional[str]:
        if art.category == "бои" and art.entities.get("stance"):
            return "Показать, где она открывается?"
        if art.category == "коллекции":
            return "Показать, сколько осталось?"
        if art.category == "сюжет" and art.spoiler:
            return "Сказать подробнее без спойлеров?"
        if art.category == "трофеи":
            return "Показать полный список?"
        return None
