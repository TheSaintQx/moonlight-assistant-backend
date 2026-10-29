"""
Moonlight Assistant — мультиигровой.
KB загружается из файла (TV шлёт его), Алиса получает мгновенный ответ,
TV опрашивает оверлей.
"""
import os, time, logging
from typing import Optional
from fastapi import FastAPI, Request, Query, Header
from fastapi.responses import JSONResponse
from kb.engine import parse_kb

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("moonlight")

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")

# device/session → {engine, last_overlay, overlay_ts, overlay_ttl}
sessions: dict[str, dict] = {}
DEFAULT_SESSION = "default"

app = FastAPI(title="Moonlight Assistant")

@app.get("/health")
def health():
    return {"ok":True,"sessions":len(sessions),
            "active":{k:(v["engine"].game if v.get("engine") else None)
                      for k,v in sessions.items()}}

# ── TV выбирает файл → шлёт сюда ──
@app.post("/import_kb")
async def import_kb(request: Request,
                    x_session: str = Header(default=DEFAULT_SESSION)):
    raw = await request.json()          # содержимое .kb.json целиком
    engine = parse_kb(_to_str(raw), GEMINI_KEY)
    sessions.setdefault(x_session, {})["engine"] = engine
    sessions[x_session]["overlay"] = None
    log.info("session=%s loaded game=%s articles=%d faq=%d",
             x_session, engine.game, len(engine.articles), len(engine.faq))
    return {"ok":True,"game":engine.game,
            "articles":len(engine.articles),"faq":len(engine.faq)}

def _to_str(x):
    return x if isinstance(x,str) else __import__("json").dumps(x, ensure_ascii=False)

# ── Алиса ──
@app.post("/alicewebhook")
async def alice(request: Request):
    body = await request.json()
    q = (body.get("message") or "").strip()
    state = body.get("state", {}) or {}
    sess = state.get("session", DEFAULT_SESSION)

    s = sessions.get(sess) or sessions.get(DEFAULT_SESSION)
    engine = s["engine"] if s and s.get("engine") else None
    if not engine:
        return {"text":"Сначала выбери базу знаний в настройках.","state":state}

    low = q.lower()
    if low in ("стоп","тише","хватит","молчи"):
        return {"text":"","state":state}
    if low in ("подробнее","расскажи подробнее","ещё деталей"):
        last = s.get("last_id") if s else None
        art = engine.articles.get(last, {}) if last else {}
        d = (art.get("quick_answer") or art.get("summary",""))
        for f in art.get("facts",[])[:3]:
            d += " " + (f.get("text","") if isinstance(f,dict) else str(f))
        return {"text":d[:400],"state":state}
    if low in ("кратко","короче"):
        last = s.get("last_id") if s else None
        art = engine.articles.get(last, {}) if last else {}
        return {"text":art.get("voice_answer") or art.get("summary","")[:100],
                "state":state}
    if low in ("сверни","убери","закрой"):
        if s: s["overlay"] = None
        return {"text":"Убрал.","state":state}

    ctx = {"act":state.get("act",0),"region":state.get("region",""),
           "spoilers_enabled":state.get("spoilers_enabled",True)}
    r = engine.ask(q, ctx)

    if s:
        s["last_id"] = (r["sources"][0] if r["sources"] else None)
        s["overlay"] = r["overlay"]
        s["overlay_ts"] = time.time()
        s["overlay_ttl"] = 8

    text = r["voice"] or r["answer"]
    if r.get("follow_up"):
        text += " " + r["follow_up"]
    return {"text":text,
            "state":dict(state, session=sess, last_article=r["sources"][:1] or [])}

# ── TV опрашивает оверлей ──
@app.get("/overlay")
def overlay(session: str = Query(default=DEFAULT_SESSION)):
    s = sessions.get(session) or sessions.get(DEFAULT_SESSION)
    if not s or not s.get("overlay"):
        return {"overlay":None,"game":None}
    age = time.time() - s.get("overlay_ts",0)
    if age > s.get("overlay_ttl",8):
        s["overlay"] = None
        return {"overlay":None,"game":None}
    return {"overlay":s["overlay"],
            "ttl_remaining":max(0,int(s.get("overlay_ttl",8)-age)),
            "game":s.get("engine").game if s.get("engine") else None}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT",8000)))
