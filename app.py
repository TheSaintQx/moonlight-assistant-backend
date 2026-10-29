"""
Moonlight Assistant Backend.
Голосовой игровой ассистент для Android TV через Алису.
"""
import os
import json
import time
import logging
from pathlib import Path
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
import uvicorn

from kb.loader import KB
from kb.faq import FAQLayer
from kb.fts import FTSIndex
from kb.vectors import VectorIndex
from kb.graph import KBGraph
from kb.router import Router
from llm.gemini import GeminiLLM

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("moonlight")

# ─── Пути ────────────────────────────────────────────────────
KB_PATH = Path("data/ghost_of_tsushima/kb.json")
FAQ_PATH = Path("data/ghost_of_tsushima/faq.json")
VEC_NPY = Path("data/ghost_of_tsushima/vectors.npy")

# ─── Инициализация ───────────────────────────────────────────
kb = KB(KB_PATH, FAQ_PATH)
fts = FTSIndex(":memory:")
fts.rebuild(kb.articles)
vi = VectorIndex(VEC_NPY)
faq_layer = FAQLayer(kb.faq)
graph = KBGraph(kb)
gemini = GeminiLLM(os.environ.get("GEMINI_API_KEY", ""))
router = Router(kb, fts, vi, faq_layer, graph, gemini)

# ─── Сессии для TV overlay (in-memory) ───────────────────────
sessions: dict[str, dict] = {}

app = FastAPI(title="Moonlight Assistant")

# ─── Health ──────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "ok": True,
        "articles": len(kb.articles),
        "faq": len(kb.faq),
        "vectors_loaded": vi.mat is not None,
    }

# ─── Алиса Webhook ───────────────────────────────────────────
@app.post("/alicewebhook")
async def alice_webhook(request: Request):
    body = await request.json()

    user_text = (body.get("message") or "").strip()
    user_id = body.get("userId", "anonymous")
    state_in = body.get("state", {}) or {}

    if not user_text:
        return {"text": "Я тебя не расслышал. Повтори.", "state": state_in}

    lower = user_text.lower()

    # Служебные команды
    if lower in ("стоп", "тише", "хватит", "молчи", "не говори"):
        sessions.pop(user_id, None)
        return {"text": "", "state": state_in}

    if lower in ("подробнее", "расскажи подробнее", "ещё деталей", "расширь"):
        return _handle_more(user_id, state_in)

    if lower in ("кратко", "короче", "скажи коротко"):
        return _handle_brief(user_id, state_in)

    if lower in ("сверни", "убери", "убери с экрана", "закрой"):
        sessions.pop(user_id, None)
        return {"text": "Убрал с экрана.", "state": state_in}

    if lower.startswith("я в ") or lower.startswith("я на "):
        return _handle_context(user_text, state_in)

    if lower in ("без спойлеров", "не порть сюжет", "скрой спойлеры"):
        state_in["spoilers_enabled"] = False
        return {"text": "Окей, без спойлеров.", "state": state_in}

    # Основной запрос
    context = {
        "act": state_in.get("act", 0),
        "region": state_in.get("region", ""),
        "spoilers_enabled": state_in.get("spoilers_enabled", True),
    }

    result = router.ask(user_text, context, session_id=user_id)

    # Сохраняем для TV
    sessions[user_id] = {
        "overlay": result.overlay,
        "created": time.time(),
        "ttl": 8,
        "article_id": result.sources[0] if result.sources else None,
    }

    # Алиса озвучивает
    reply_text = result.voice if result.voice else result.answer
    if result.follow_up:
        reply_text += " " + result.follow_up

    out_state = dict(state_in)
    out_state["last_article"] = result.sources[0] if result.sources else None

    log.info("user=%s q=%s tier=%s conf=%.2f", user_id, user_text, "LLM" if result.used_llm else "KB", result.confidence)
    return {"text": reply_text, "state": out_state}

def _handle_more(user_id: str, state_in: dict) -> dict:
    last = state_in.get("last_article")
    if not last or last not in kb.articles:
        return {"text": "Сначала задай вопрос.", "state": state_in}
    art = kb.articles[last]
    detail = art.get_quick_answer()
    for f in art.facts[:3]:
        text = f.get("text", "") if isinstance(f, dict) else str(f)
        detail += " " + text
    return {"text": detail[:400], "state": state_in}

def _handle_brief(user_id: str, state_in: dict) -> dict:
    last = state_in.get("last_article")
    if not last or last not in kb.articles:
        return {"text": "Сначала задай вопрос.", "state": state_in}
    art = kb.articles[last]
    return {"text": art.get_voice_answer(), "state": state_in}

def _handle_context(user_text: str, state_in: dict) -> dict:
    lower = user_text.lower()
    s = dict(state_in)
    region_map = {
        "идзухара": "izuhara", "идзухаре": "izuhara", "идзухары": "izuhara",
        "тоетама": "toyotama", "тоётама": "toyotama",
        "камиагата": "kamiagata",
        "ики": "iki", "остров ики": "iki",
    }
    for key, val in region_map.items():
        if key in lower:
            s["region"] = val
            break
    for phrase, act_num in [("первый акт", 1), ("акт 1", 1),
                            ("второй акт", 2), ("акт 2", 2), ("втором", 2),
                            ("третий акт", 3), ("акт 3", 3), ("третьем", 3)]:
        if phrase in lower:
            s["act"] = act_num
            break
    return {"text": "Понял, запомнил.", "state": s}

# ─── TV Overlay Polling ──────────────────────────────────────
@app.get("/overlay")
def tv_overlay(session: str = ""):
    if not session:
        return {"overlay": None}
    data = sessions.get(session)
    if not data:
        return {"overlay": None}
    age = time.time() - data["created"]
    if age > data["ttl"]:
        sessions.pop(session, None)
        return {"overlay": None}
    return {
        "overlay": data["overlay"],
        "ttl_remaining": max(0, int(data["ttl"] - age)),
    }

# ─── Запуск ──────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
