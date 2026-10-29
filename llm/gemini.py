"""
Gemini fallback: вызывается ТОЛЬКО если FAQ и FTS не справились.
"""
import json
import logging
from typing import Optional

log = logging.getLogger(__name__)

try:
    import google.generativeai as genai
except ImportError:
    genai = None

PROMPT = """Ты голосовой игровой ассистент по игре {game}.
Язык: русский. Отвечай ТОЛЬКО на основе CONTEXT ниже.
Не выдумывай. Если CONTEXT не хватает — скажи «не уверен».

Голосовой ответ (поле "voice") — максимум 2 предложения, без воды.
Поле "bullets" — до 3 коротких пунктов для оверлея на TV.

Ответь строго JSON:
{{"answer": "...", "voice": "...", "bullets": ["...", "...", "..."], "confidence": 0.85, "spoiler": false, "sources": ["article_id"]}}

CONTEXT:
{context}

ВОПРОС:
{q}"""

class GeminiLLM:
    def __init__(self, api_key: str):
        self.api_key = api_key
        if api_key and genai:
            genai.configure(api_key=api_key)

    def ask(self, q: str, context_text: str, game: str = "Ghost of Tsushima") -> Optional[dict]:
        if not self.api_key or not genai:
            log.warning("Gemini не настроен, пропускаю LLM")
            return None

        prompt = PROMPT.format(game=game, context=context_text or "(нет контекста)", q=q)

        try:
            model = genai.GenerativeModel("gemini-2.0-flash")
            response = model.generate_content(
                prompt,
                generation_config={
                    "temperature": 0.1,
                    "max_output_tokens": 300,
                },
            )
            text = response.text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            return json.loads(text)
        except Exception as e:
            log.error("Gemini ошибка: %s", e)
            return None
