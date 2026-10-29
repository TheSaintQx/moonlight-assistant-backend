"""
Moonlight Assistant Backend (multi-game).
Голосовой игровой ассистент для Android TV через Алису.
Поддерживает несколько игр одновременно. Смена — через /setgame.
"""
import os
import json
import time
import logging
from pathlib import Path
from typing import Optional
from fastapi import FastAPI, Request, Query
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

# ─── Мультиигровая загрузка ──────────────────────────────────
DATA_DIR = Path("data")
GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")

# Загружаем ВСЕ игры из data/
games: dict[str, dict] = {}  # game_slug → {kb, fts, router, faq, graph, vec}

def load_games():
    global games
    games = {}
    if not DATA_DIR.exists():
        log.warning("Папка data/ не найдена")
        return
    for game_dir in sorted(DATA_DIR.iterdir()):
        if not game_dir.is_dir():
            continue
        kb_path = game_dir / "kb.json"
        faq_path = game_dir / "faq.json"
        vec_path = game_dir / "vectors.npy"
        if not kb_path.exists():
            log.warning("Пропускаю %s: нет kb.json", game_dir.name)
            continue
        try:
            kb = KB(kb_path, faq_path if faq_path.exists() else None)
            fts = FTSIndex(":memory:")
            fts.rebuild(kb.articles)
            vi = VectorIndex(vec_path)
            faq_layer = FAQLayer(kb.faq)
            graph = KBGraph(kb)
            gemini = GeminiLLM(GEMINI_KEY)
            router = Router(kb, fts, vi, faq_layer, graph, gemini)
            games[game_dir.name] = {
                "kb": kb,
                "router": router,
                "faq_count": len(kb.faq),
                "article_count": len(kb.articles),
                "game_name": kb.game,
            }
            log.info("Загружена игра: %s (%d статей, %d FAQ)",
                     game_dir.name, len(kb.articles), len(kb.faq))
        except Exception as e:
            log.error("Ошибка загрузки %s: %s", game_dir.name, e)

load_games()

# Дефолтная игра — первая найденная (или ghost_of_tsushima)
DEFAULT_GAME = "ghost_of_tsushima" if "ghost_of_tsushima" in games else (
    next(iter(games), None)
)

# ─── Сессии TV (in-memory) ───────────────────────────────────
# session_key → { active_game, overlay, created, ttl, last_article, ...state }
sessions: dict[str, dict] = {}

app = FastAPI(title="Moonlight Assistant (multi-game)")

# ─── Health ──────────────────────────────────────────────────
@app.get("/health")
def health():
    return {
        "ok": True,
        "games_loaded": {k: {"articles": v["article_count"], "faq": v["faq_count"]}
                        for k, v in games.items()},
        "default_game": DEFAULT_GAME,
        "active_sessions": len(sessions),
    }

# ─── Смена игры (TV шлёт при смене в настройках) ────────────
@app.post("/setgame")
def set_game(session: str = Query(...), game: str = Query(...)):
    """
    TV-приложение шлёт этот запрос при смене игры в настройках.
    Пример: POST /setgame?session=tv_anon&game=elden_ring
    """
    if game not in games:
        available = ", ".join(games.keys())
        return {
            "ok": False,
            "error": f"Игра '{game}' не найдена. Доступны: {available}",
        }

    s = sessions.setdefault(session, {})
    s["active_game"] = game
    s["state"] = {}  # сбрасываем контекст при смене игры
    s["last_article"] = None

    log.info("Сессия %s → игра %s", session, game)
    return {"ok": True, "game": game, "game_name": games[game]["game_name"]}

# ─── Алиса Webhook ───────────────────────────────────────────
@app.post("/alicewebhook")
async def alice_webhook(request: Request):
    body = await request.json()

    user_text = (body.get("message") or "").strip()
    user_id = body.get("userId", "anonymous")
    state_in = body.get("state", {}) or {}

    # Определяем активную игру для этой сессии
    session_key = f"tv_{user_id}"
    s = sessions.setdefault(session_key, {})
    active_game = s.get("active_game", DEFAULT_GAME)

    # Если игра не найдена — берём дефолт
    if active_game not in games:
        active_game = DEFAULT_GAME
    g = games[active_game]
    kb = g["kb"]
    router = g["router"]

    if not user_text:
        return {"text": "Я тебя не расслышал. Повтори.", "state": state_in}

    lower = user_text.lower()

    # Служебные команды
    if lower in ("стоп", "тише", "хватит", "молчи", "не говори"):
        sessions.pop(session_key, None)
        return {"text": "", "state": state_in}

    if lower in ("подробнее", "расскажи подробнее", "ещё деталей", "расширь"):
        return _handle_more(session_key, state_in, kb)

    if lower in ("кратко", "короче", "скажи коротко"):
        return _handle_brief(session_key, state_in, kb)

    if lower in ("сверни", "убери", "убери с экрана", "закрой"):
        sessions.pop(session_key, None)
        return {"text": "Убрал с экрана.", "state": state_in}

    if lower.startswith("я в ") or lower.startswith("я на "):
        return _handle_context(user_text, state_in)

    if lower in ("без спойлеров", "не порть сюжет", "скрой спойлеры"):
        state_in["spoilers_enabled"] = False
        return {"text": "Окей, без спойлеров.", "state": state_in}

    # Смена игры голосом (опционально)
    switch_map = {
        "цусима": "ghost_of_tsushima",
        "гон": "ghost_of_tsushima",
        "эльден": "elden_ring",
        "hades": "hades2",
    }
    for phrase, slug in switch_map.items():
        if phrase in lower and slug in games:
            s["active_game"] = slug
            s["state"] = {}
            return {"text": f"Переключил на {games[slug]['game_name']}.", "state": {}}

    # Основной запрос
    context = {
        "act": state_in.get("act", 0),
        "region": state_in.get("region", ""),
        "spoilers_enabled": state_in.get("spoilers_enabled", True),
        "game": active_game,
    }

    result = router.ask(user_text, context, session_id=session_key)

    # Сохраняем для TV
    s["overlay"] = result.overlay
    s["overlay_created"] = time.time()
    s["overlay_ttl"] = 8
    s["last_article"] = result.sources[0] if result.sources else None

    # Алиса озвучивает
    reply_text = result.voice if result.voice else result.answer
    if result.follow_up:
        reply_text += " " + result.follow_up

    out_state = dict(state_in)
    out_state["last_article"] = s["last_article"]
    out_state["game"] = active_game

    log.info("game=%s user=%s q=%s tier=%s conf=%.2f",
             active_game, user_id, user_text,
             "LLM" if result.used_llm else "KB", result.confidence)
    return {"text": reply_text, "state": out_state}

def _handle_more(session_key: str, state_in: dict, kb: KB) -> dict:
    last = state_in.get("last_article")
    if not last or last not in kb.articles:
        return {"text": "Сначала задай вопрос.", "state": state_in}
    art = kb.articles[last]
    detail = art.get_quick_answer()
    for f in art.facts[:3]:
        text = f.get("text", "") if isinstance(f, dict) else str(f)
        detail += " " + text
    return {"text": detail[:400], "state": state_in}

def _handle_brief(session_key: str, state_in: dict, kb: KB) -> dict:
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
        "камиагата": "kamiagata", "ики": "iki", "остров ики": "iki",
        "лириэль": "liyrie", "лендлорд": "landlord", "лирия": "liaria",
        "меленгария": "melennia", "аллиор": "aellia", "ад": "hell",
    }
    for key, val in region_map.items():
        if key in lower:
            s["region"] = val
            break
    for phrase, act_num in [("первый акт", 1), ("акт 1", 1),
                            ("второй акт", 2), ("акт 2", 2),
                            ("третий акт", 3), ("акт 3", 3)]:
        if phrase in lower:
            s["act"] = act_num
            break
    return {"text": "Понял, запомнил.", "state": s}

# ─── TV Overlay Polling ──────────────────────────────────────
@app.get("/overlay")
def tv_overlay(session: str = Query("")):
    if not session:
        return {"overlay": None, "game": None}
    data = sessions.get(session)
    if not data:
        return {"overlay": None, "game": None}
    age = time.time() - data.get("overlay_created", 0)
    ttl = data.get("overlay_ttl", 8)
    if age > ttl:
        data.pop("overlay", None)
        return {"overlay": None, "game": data.get("active_game", DEFAULT_GAME)}
    return {
        "overlay": data.get("overlay"),
        "ttl_remaining": max(0, int(ttl - age)),
        "game": data.get("active_game", DEFAULT_GAME),
    }

# ─── Список доступных игр (для TV-настроек) ─────────────────
@app.get("/games")
def list_games():
    return {
        "games": [
            {"slug": k, "name": v["game_name"], "articles": v["article_count"]}
            for k, v in games.items()
        ],
        "default": DEFAULT_GAME,
    }

# ─── Запуск ──────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run(app, host="0.0.0.0", port=port)
