"""
Конвертер: текущий kb.json → добавляет quick_answer, voice_answer,
overlay_card, questions в каждую статью.
Запуск локально: python scripts/convert_kb.py
"""
import json
import copy
from pathlib import Path

KB_PATH = Path("data/ghost_of_tsushima/kb.json")
OUT_PATH = Path("data/ghost_of_tsushima/kb.json")

def make_voice(summary: str) -> str:
    s = summary.strip()
    if len(s) > 100:
        for i, ch in enumerate(s):
            if ch in ".!?" and i > 20:
                s = s[: i + 1]
                break
        else:
            s = s[:100] + "…"
    return s

def make_overlay(article: dict) -> dict:
    bullets = []
    for f in article.get("facts", [])[:3]:
        text = f if isinstance(f, str) else f.get("text", "")
        bullets.append(text[:60])
    return {
        "type": "answer",
        "title": article.get("title", ""),
        "short": article.get("summary", "")[:80],
        "bullets": bullets,
        "image": article.get("template", ""),
    }

def main():
    raw = json.loads(KB_PATH.read_text(encoding="utf-8"))
    articles = raw.get("articles", [])

    for a in articles:
        if not a.get("quick_answer"):
            a["quick_answer"] = a.get("summary", "")
        if not a.get("voice_answer"):
            a["voice_answer"] = make_voice(a.get("summary", ""))
        if not a.get("overlay_card"):
            a["overlay_card"] = make_overlay(a)
        if not a.get("questions"):
            qs = set(a.get("aka", []))
            for t in a.get("tags", []):
                if len(t) > 3:
                    qs.add(t)
            a["questions"] = list(qs)[:10]
        a.setdefault("entities", {})
        a.setdefault("spoiler", False)
        a.setdefault("act", 0)
        a.setdefault("requires_dlc", False)
        a.setdefault("confidence", 0.9)
        a.setdefault("verified", False)
        a.setdefault("last_reviewed", "")

    raw["version"] = 2
    OUT_PATH.write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"OK: {len(articles)} статей, путь {OUT_PATH}")

if __name__ == "__main__":
    main()
