"""Small one-shot bridge to rany2/edge-tts; stdout is reserved for MP3 bytes/JSON."""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

VOICE = "pt-BR-ThalitaMultilingualNeural"
RATE = "+0%"
PITCH = "+0Hz"

# Alteração local da Kirana (Marco 3): velocidade ajustável.
# O arquivo original do patch Thalita v0.4.0 tem RATE fixo em "+0%", o que dá
# ~146 palavras/min — abaixo da faixa pedida (150–180). Aqui o servidor pode
# enviar `rate`, validado por lista fechada para não permitir valores
# arbitrários no motor.
ALLOWED_RATES = {
    "-20%": "-20%", "-15%": "-15%", "-10%": "-10%", "-5%": "-5%", "+0%": "+0%",
    "+5%": "+5%", "+8%": "+8%", "+10%": "+10%", "+15%": "+15%", "+20%": "+20%",
}


def sanitize_text(text: str) -> str:
    import re
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"```[^\n]*\n?|```", " ", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"https?://\S+|www\.\S+", " ", text)
    text = re.sub(r"(?m)^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)", "", text)
    text = re.sub(r"[*_~]{1,3}", "", text)
    text = re.sub(r"[\U0001F000-\U0001FAFF\U00002600-\U000027BF\U0001F1E6-\U0001F1FF\uFE0E\uFE0F\u200d\u20e3]", "", text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\s*\n+\s*", " ", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return text.strip()


async def list_voices() -> None:
    from edge_tts import list_voices as get_voices
    items = await get_voices()
    result = [
        {"shortName": item.get("ShortName"), "locale": item.get("Locale"),
         "localeName": item.get("LocaleName"), "gender": item.get("Gender"),
         "friendlyName": item.get("FriendlyName"), "status": item.get("Status")}
        for item in items
        if item.get("ShortName") in (VOICE, "pt-BR-FranciscaNeural")
    ]
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


async def stream_audio(text: str, rate: str = RATE) -> None:
    from edge_tts import Communicate
    text = sanitize_text(text)
    if not text:
        raise ValueError("empty_speech_text")
    if rate not in ALLOWED_RATES:
        raise ValueError("invalid_rate")
    communicate = Communicate(text, voice=VOICE, rate=ALLOWED_RATES[rate], pitch=PITCH)
    try:
        async for message in communicate.stream():
            if message.get("type") == "audio":
                sys.stdout.buffer.write(message["data"])
                sys.stdout.buffer.flush()
    except BrokenPipeError:
        return


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-voices", action="store_true")
    args = parser.parse_args()
    try:
        if args.list_voices:
            await list_voices()
            return
        payload = json.load(sys.stdin)
        if not isinstance(payload, dict) or not isinstance(payload.get("text"), str):
            raise ValueError("invalid_request")
        extra = set(payload) - {"text", "rate"}
        if extra:
            raise ValueError("invalid_request")
        rate = payload.get("rate", RATE)
        if not isinstance(rate, str):
            raise ValueError("invalid_rate")
        await stream_audio(payload["text"], rate)
    except Exception as exc:
        # Avoid writing user text, credentials, or service response details to logs.
        print(f"edge_tts_worker_error:{type(exc).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(2)


if __name__ == "__main__":
    asyncio.run(main())
