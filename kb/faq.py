"""
FAQ слой: exact + fuzzy match.
Если вопрос совпал с FAQ → отвечаем БЕЗ LLM.
"""
import re
from difflib import SequenceMatcher

class FAQLayer:
    def __init__(self, faq: list[dict]):
        self.entries = faq
        self._norm_q: dict[str, dict] = {}
        self._norm_alias: dict[str, dict] = {}

        for e in faq:
            self._norm_q[self._normalize(e.get("question", ""))] = e
            for alias in e.get("aliases", []):
                self._norm_alias[self._normalize(alias)] = e

    @staticmethod
    def _normalize(s: str) -> str:
        s = s.lower().strip()
        s = re.sub(r"[^a-zа-яё0-9\s]", "", s)
        s = re.sub(r"\s+", " ", s)
        return s

    def exact(self, q: str) -> dict | None:
        nq = self._normalize(q)
        if nq in self._norm_q:
            return self._norm_q[nq]
        if nq in self._norm_alias:
            return self._norm_alias[nq]
        return None

    def fuzzy(self, q: str, threshold: float = 0.82) -> tuple[dict, float] | None:
        nq = self._normalize(q)
        best: dict | None = None
        best_score = 0.0

        for e in self.entries:
            s1 = SequenceMatcher(None, nq, self._normalize(e.get("question", ""))).ratio()
            s2 = 0.0
            for alias in e.get("aliases", []):
                s2 = max(s2, SequenceMatcher(None, nq, self._normalize(alias)).ratio())
            score = max(s1, s2)
            if score > best_score:
                best_score = score
                best = e

        if best and best_score >= threshold:
            return best, best_score
        return None
