"""
Moonlight Assistant — Full Multi-Client Support.
Supports:
1. Yandex Alice / Dialogs Webhook
2. Android TV Client (Moonlight) for KB, Context, and Overlay
"""
import os
import json
import time
import logging
from pathlib import Path
from typing import Optional, List, Dict
from fastapi import FastAPI, Request, Query, HTTPException, Header
from fastapi.responses import JSONResponse

# ─── ЛОГИРОВАНИЕ И ИМПОРТЫ ───
logging.basicConfig(level=logging.INFO)
log = logging.getLogger("moonlight")

# Импорт движка (kb/engine.py)
try:
    from kb.engine import parse_kb
except ImportError:
    parse_kb = None

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
ASSISTANT_TOKEN = os.environ.get("ASSISTANT_TOKEN", "secret") # Для проверки

# ─── КАРТА: координаты меток для локального HTML-оверлея ───
# Файл кладётся рядом с app.py: data/ghost_of_tsushima/tsushima_map_data.json
# Формат: {"image":"tsushima.png","points":[{"id","type","color","x","y"}]}
MAP_DATA_PATH = Path(os.environ.get("MAP_DATA_PATH", "data/ghost_of_tsushima/tsushima_map_data.json"))

# Ключевые слова, по которым Алиса должна показать точку на карте
# (запускать ДО основного process_query, чтобы не ждать LLM)
MAP_KEYWORDS = {
    "haiku":    ["хайку", "poetic haiku", "поэтический хайку"],
    "hot_spring":["источник", "горяч", "сено", "банный"],
    "shrine":   ["святилищ", "инвари", "инари", "бамбук", "амулет"],
    "lighthouse":["маяк", "маяки"],
    "duel":     ["дуэл", "смертельный"],
    "generic":  ["где", "покажи", "ближайш", "на карте", "маркер"],
}
# Приоритет: если найден конкретный тип — используем его; иначе — generic (случайная из всех)
def find_map_point(utterance: str, data: dict) -> dict | None:
    lower = utterance.lower()
    for point_type, words in MAP_KEYWORDS.items():
        if any(w in lower for w in words):
            pts = [p for p in data.get("points", [])
                   if p.get("type") == point_type or p.get("color") == point_type]
            if pts:
                import random
                p = random.choice(pts)
                name_map = {"haiku":"Хайку","hot_spring":"Горячий источник","shrine":"Святилище",
                            "lighthouse":"Маяк","duel":"Смертельная дуэль"}
                label = p.get("label") or name_map.get(point_type, point_type.title())
                return {
                    "mode": "map",
                    "x": p["x"], "y": p["y"],
                    "label": label,
                    "ttl": 8,
                    "image": data.get("image", "tsushima.png"),
                    "hint": "tsushima_offline_map.html",
                }
    # Generic «где/покажи/ближайший» — берём случайную из всех точек
    all_pts = data.get("points", [])
    if all_pts and any(w in lower for w in MAP_KEYWORDS["generic"]):
        import random
        p = random.choice(all_pts)
        return {
            "mode": "map",
            "x": p["x"], "y": p["y"],
            "label": p.get("label", p.get("id", "Точка")),
            "ttl": 8,
            "image": data.get("image", "tsushima.png"),
            "hint": "tsushima_offline_map.html",
        }
    return None

def load_map_data() -> dict | None:
    if MAP_DATA_PATH.exists():
        try:
            return json.loads(MAP_DATA_PATH.read_text(encoding="utf-8"))
        except Exception as e:
            log.warning(f"Map data load failed: {e}")
    return None

app = FastAPI(title="Moonlight Assistant")

# Хранилище сессий: session_id -> { "engine": Engine, "context": {...}, "overlay": {...} }
sessions = {}

# ─── ИНИЦИАЛИЗАЦИЯ ДВИЖКА ПО УМОЛЧАНИЮ ───
# Если в репо лежит файл data/ghost_of_tsushima/kb.json, загрузим его как дефолт
default_engine = None
default_kb_path = Path("data/ghost_of_tsushima/kb.json")
if default_kb_path.exists() and parse_kb:
    try:
        kb_text = default_kb_path.read_text(encoding="utf-8")
        default_engine = parse_kb(kb_text, GEMINI_KEY)
        log.info(f"Default engine loaded from {default_kb_path}. Articles: {len(default_engine.articles)}")
    except Exception as e:
        log.warning(f"Could not load default KB: {e}")

# ─── УТИЛИТЫ ───
def get_or_create_session(session_id: str) -> dict:
    if session_id not in sessions:
        sessions[session_id] = {
            "engine": default_engine,
            "context": {"region": "", "act": 0, "spoilers_enabled": True},
            "last_id": None,
            "overlay": None,
            "overlay_ts": 0,
            "overlay_ttl": 8
        }
    return sessions[session_id]

def process_query(text: str, context: dict, engine) -> dict:
    if not engine:
        return {"answer": "База знаний не загружена.", "voice": "База не загружена.", "sources": [], "overlay": None}
    try:
        return engine.ask(text, context)
    except Exception as e:
        log.error(f"Error in engine: {e}")
        return {"answer": "Ошибка обработки запроса.", "voice": "Ошибка.", "sources": [], "overlay": None}

def check_token(authorization: str = ""):
    if not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Invalid token")
    token = authorization.split(" ")[1]
    if token != ASSISTANT_TOKEN:
        raise HTTPException(status_code=401, detail="Invalid token")

# ═══════════════════════════════════════════════════════════════
# 1. АЛИСА / ЯНДЕКС ДИАЛОГИ (WEBHOOK)
# ═══════════════════════════════════════════════════════════════

@app.post("/v1/alicewebhook")
async def alice_webhook(request: Request):
    """
    Официальный обработчик для Yandex Dialogs Webhook.
    """
    body = await request.json()
    
    # Извлекаем данные
    req = body.get("request", {})
    session_data = body.get("session", {})
    
    utterance = (req.get("original_utterance") or req.get("command") or "").strip()
    # Используем user_id для привязки сессии (или session_id, если нужно глобально)
    alice_session_id = session_data.get("user_id", "default_alice_user")
    
    log.info(f"[ALICE] Query: '{utterance}' | Session: {alice_session_id}")
    
    if not utterance:
        return JSONResponse(content={"error": "Empty utterance"}, status_code=400)
    
    lower = utterance.lower()
    s = get_or_create_session(alice_session_id)
    ctx = s["context"]
    
    # Служебные команды
    if lower in ("стоп", "тише", "хватит", "молчи"):
        return {"status": "succeeded", "text": ""}
    
    # Обновление контекста
    if lower.startswith("я в ") or lower.startswith("я на "):
        region_map = {
            "идзухара": "izuhara", "идзухаре": "izuhara", "идзухары": "izuhara",
            "тоетама": "toyotama", "тоётама": "toyotama",
            "камиагата": "kamiagata",
            "ики": "iki", "остров ики": "iki"
        }
        for key, val in region_map.items():
            if key in lower:
                ctx["region"] = val
                log.info(f"[ALICE] Context updated: Region={val}")
                return {"status": "succeeded", "text": f"Запомнил, ты в {val.title()}."}
        
        for phrase, act_num in [("первый акт", 1), ("акт 1", 1),
                                ("второй акт", 2), ("акт 2", 2),
                                ("третий акт", 3), ("акт 3", 3)]:
            if phrase in lower:
                ctx["act"] = act_num
                return {"status": "succeeded", "text": f"Запомнил, ты на {act_num}-м акте."}
                
        return {"status": "succeeded", "text": "Не понял. Скажи регион или акт."}

    if lower in ("без спойлеров", "не порть сюжет"):
        ctx["spoilers_enabled"] = False
        return {"status": "succeeded", "text": "Окей, без спойлеров."}

    if lower in ("подробнее", "расскажи подробнее"):
        last = s.get("last_id")
        art = s["engine"].articles.get(last, {}) if last and s.get("engine") else {}
        if not art:
            return {"status": "succeeded", "text": "Сначала задай основной вопрос."}
        d = art.get("quick_answer", art.get("summary", ""))
        for f in art.get("facts", [])[:3]:
            text = f.get("text", "") if isinstance(f, dict) else str(f)
            d += " " + text
        return {"status": "succeeded", "text": d[:400]}

    if lower in ("кратко", "короче"):
        last = s.get("last_id")
        art = s["engine"].articles.get(last, {}) if last and s.get("engine") else {}
        if not art:
            return {"status": "succeeded", "text": "Сначала задай основной вопрос."}
        return {"status": "succeeded", "text": art.get("voice_answer", art.get("summary", ""))[:100]}

    if lower in ("сверни", "убери", "закрой"):
        s["overlay"] = None
        return {"status": "succeeded", "text": "Убрал."}

    # ── КАРТА: «где хайку / покажи маяк / ближайший источник» ──
    # Локальная логика — не ждём LLM, отвечаем мгновенно
    map_data = s.get("_map_data") or load_map_data()
    if map_data:
        s["_map_data"] = map_data  # кэшируем в сессии
        pt = find_map_point(utterance, map_data)
        if pt:
            s["overlay"] = pt
            s["overlay_ts"] = time.time()
            s["overlay_ttl"] = pt.get("ttl", 8)
            region = ctx.get("region", "")
            region_txt = f" (ближе к {region.title()})" if region else ""
            return {
                "status": "succeeded",
                "text": f"{pt['label']}{region_txt} — координаты переданы на карту. "
                        f"Кружок появится в углу на {pt.get('ttl', 8)} секунд."
            }

    # Основной запрос
    result = process_query(utterance, ctx, s["engine"])
    
    # Сохраняем оверлей
    if result.get("overlay"):
        s["overlay"] = result["overlay"]
        s["overlay_ts"] = time.time()
    
    if result.get("sources"):
        s["last_id"] = result["sources"][0]

    voice_text = result.get("voice") or result.get("answer")
    if result.get("follow_up"):
        voice_text += " " + result["follow_up"]
        
    return {"status": "succeeded", "text": voice_text}

# ═══════════════════════════════════════════════════════════════
# 2. АНДРОИД КЛИЕНТ (MOONLIGHT)
# ═══════════════════════════════════════════════════════════════

@app.post("/v1/kb")
async def import_kb(request: Request, authorization: str = Header(default="")):
    """
    Android Client загружает базу.
    """
    check_token(authorization)
    kb_data = await request.json()
    
    if "articles" not in kb_data:
        raise HTTPException(400, "Missing 'articles'")
    
    if not parse_kb:
        raise HTTPException(500, "Engine not available")
        
    # Используем дефолтную сессию или можно парсить сессию из других параметров, если бы они были
    s = get_or_create_session("android_client_default")
    
    try:
        engine = parse_kb(json.dumps(kb_data, ensure_ascii=False), GEMINI_KEY)
        s["engine"] = engine
        s["overlay"] = None
        log.info(f"[ANDROID] KB Loaded. Articles: {len(engine.articles)}")
        return {"status": "success", "articles_count": len(engine.articles)}
    except Exception as e:
        log.error(f"Error parsing KB: {e}")
        raise HTTPException(500, f"Failed to parse KB: {str(e)}")

@app.post("/v1/context/frame")
async def context_frame(request: Request, authorization: str = Header(default="")):
    """
    Android Client шлет кадры. Пока просто принимаем.
    """
    check_token(authorization)
    # В будущем здесь будет анализ OpenCV/Vision
    return {"status": "received"}

@app.get("/v1/overlay/pending")
def overlay_pending(authorization: str = Header(default="")):
    """
    Android Client опрашивает оверлей.
    """
    check_token(authorization)
    s = get_or_create_session("android_client_default")
    overlay = s.get("overlay")
    
    if not overlay:
        return {"overlay": None}
        
    age = time.time() - s.get("overlay_ts", 0)
    if age > s.get("overlay_ttl", 8):
        s["overlay"] = None
        return {"overlay": None}
        
    # Формируем ответ в формате, который ожидает клиент (mode: circle/arrow)
    # Пока передаем как есть, или можем маппить если нужно
    return {"overlay": overlay}

@app.get("/health")
def health():
    return {"ok": True, "engine_loaded": default_engine is not None}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
