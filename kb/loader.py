"""
Загрузка KB и FAQ из JSON.
Совместим со старой структурой (facts = list[str])
и новой (facts = list[dict]).
"""
import json
import dataclasses
from pathlib import Path
from typing import Optional

@dataclasses.dataclass
class Article:
    id: str
    title: str
    summary: str
    quick_answer: str = ""
    voice_answer: str = ""
    questions: list = dataclasses.field(default_factory=list)
    entities: dict = dataclasses.field(default_factory=dict)
    overlay_card: Optional[dict] = None
    aka: list = dataclasses.field(default_factory=list)
    tags: list = dataclasses.field(default_factory=list)
    url: str = ""
    priority: int = 2
    links: list = dataclasses.field(default_factory=list)
    category: str = "прочее"
    location: str = ""
    template: str = ""
    language: str = "ru"
    version: int = 1
    facts: list = dataclasses.field(default_factory=list)
    spoiler: bool = False
    act: int = 0
    requires_dlc: bool = False
    confidence: float = 0.9
    verified: bool = False
    last_reviewed: str = ""

    def get_quick_answer(self) -> str:
        if self.quick_answer:
            return self.quick_answer
        return self.summary

    def get_voice_answer(self) -> str:
        if self.voice_answer:
            return self.voice_answer
        qa = self.get_quick_answer()
        return qa[:120] + ("..." if len(qa) > 120 else "")

class KB:
    def __init__(self, kb_path: Path, faq_path: Optional[Path] = None):
        raw = json.loads(kb_path.read_text(encoding="utf-8"))
        self.game: str = raw.get("game", "unknown")
        self.language: str = raw.get("language", "ru")
        self.overlay_config: dict = raw.get("overlay", {})

        self.articles: dict[str, Article] = {}
        for a in raw.get("articles", []):
            self.articles[a["id"]] = self._parse_article(a)

        self.faq: list[dict] = []
        if faq_path and faq_path.exists():
            faq_raw = json.loads(faq_path.read_text(encoding="utf-8"))
            self.faq = faq_raw.get("faq", [])

    @staticmethod
    def _parse_article(a: dict) -> Article:
        raw_facts = a.get("facts", [])
        facts = []
        for f in raw_facts:
            if isinstance(f, str):
                facts.append({"text": f, "source": "kb", "confidence": 0.9, "verified": False})
            elif isinstance(f, dict):
                f.setdefault("text", "")
                f.setdefault("source", "kb")
                f.setdefault("confidence", 0.9)
                f.setdefault("verified", False)
                facts.append(f)

        return Article(
            id=a["id"],
            title=a.get("title", ""),
            summary=a.get("summary", ""),
            quick_answer=a.get("quick_answer", ""),
            voice_answer=a.get("voice_answer", ""),
            questions=a.get("questions", []),
            entities=a.get("entities", {}),
            overlay_card=a.get("overlay_card"),
            aka=a.get("aka", []),
            tags=a.get("tags", []),
            url=a.get("url", ""),
            priority=a.get("priority", 2),
            links=a.get("links", []),
            category=a.get("category", "прочее"),
            location=a.get("location", ""),
            template=a.get("template", ""),
            language=a.get("language", "ru"),
            version=a.get("version", 1),
            facts=facts,
            spoiler=a.get("spoiler", False),
            act=a.get("act", 0),
            requires_dlc=a.get("requires_dlc", False),
            confidence=a.get("confidence", 0.9),
            verified=a.get("verified", False),
            last_reviewed=a.get("last_reviewed", ""),
        )

    def get(self, article_id: str) -> Optional[Article]:
        return self.articles.get(article_id)
