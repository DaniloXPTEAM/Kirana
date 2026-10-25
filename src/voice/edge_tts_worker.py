"""Small one-shot bridge to rany2/edge-tts; stdout is reserved for MP3 bytes/JSON.

Kirana v0.4.2 — duas correções de pronúncia/latência medidas no Windows:

1. STDIN SEMPRE UTF-8. O Node envia JSON em UTF-8, mas o Python usa a
   codificação do locale para stdio; no Windows com pipe isso é a página ANSI
   (cp1252 em pt-BR). O resultado era o worker receber "eleiÃ§Ãµes" e mandar
   isso para o motor — áudio diferente e pronúncia errada (reproduzido:
   20736 bytes corretos vs 25344 bytes corrompidos para a mesma frase).
   Aqui o stdin é reconfigurado para UTF-8 e, quando a versão do Python não
   permite, o JSON com escapes de barra-u e quatro hexadecimais é decodificado
   à força.

2. VOZ POR REQUISIÇÃO, com lista fechada. O servidor escolhe entre as vozes
   pt-BR (Thalita continua o padrão); nada arbitrário chega ao motor.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys

VOICE = "pt-BR-ThalitaMultilingualNeural"
RATE = "+0%"

#: Vozes pt-BR aceitas. Lista fechada: o valor vai para o motor externo.
ALLOWED_VOICES = (
    "pt-BR-ThalitaMultilingualNeural",
    "pt-BR-FranciscaNeural",
    "pt-BR-AntonioNeural",
    "pt-BR-BrendaNeural",
    "pt-BR-DonatoNeural",
    "pt-BR-ElzaNeural",
    "pt-BR-FabioNeural",
    "pt-BR-GiovannaNeural",
    "pt-BR-HumbertoNeural",
    "pt-BR-JulioNeural",
    "pt-BR-LeilaNeural",
    "pt-BR-LeticiaNeural",
    "pt-BR-ManuelaNeural",
    "pt-BR-NicolauNeural",
    "pt-BR-ThalitaNeural",
    "pt-BR-ValerioNeural",
    "pt-BR-YaraNeural",
)
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


def _is_speakable_char(char: str) -> bool:
    """Mesma política de `src/voice/tts-text.js` (lista de permissão).

    A v0.4.0 removia emojis por faixas de código fixas, que deixavam passar
    símbolos falados como palavra (ex.: £ lido como "libra"). Aqui a regra é
    positiva: só letra, número, marca de acentuação, espaço e a pontuação
    fechada abaixo passam.
    """
    import unicodedata

    if char in ALLOWED_PUNCTUATION:
        return True
    if char.isspace():
        return True
    code = ord(char)
    # seletores de variação e keycap são "marcas" para o Unicode, mas invisíveis
    if 0xFE00 <= code <= 0xFE0F or code == 0x20E3 or 0xE0100 <= code <= 0xE01EF:
        return False
    return unicodedata.category(char)[0] in ("L", "N", "M")


ALLOWED_PUNCTUATION = set(".,;:!?'\"()[]{}«»-–—…%/$°")


def sanitize_text(text: str) -> str:
    """Limpa o texto para fala. Nada fora da política chega ao motor."""
    import re

    # --- estruturais -------------------------------------------------------
    text = re.sub(r"```[\s\S]*?```", " ", text)
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"!\[([^\]]*)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    text = re.sub(r"https?://\S+|www\.\S+", " ", text)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"(?m)^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)", "", text)
    text = re.sub(r"[*_~]{1,3}", "", text)
    text = re.sub(r"(?m)^\s*\|(.+)\|\s*$", lambda m: m.group(1).replace("|", ", "), text)
    text = re.sub(r"(?m)^\s*([-*_]\s*){3,}$", " ", text)

    # --- política de caracteres -------------------------------------------
    text = "".join(char if _is_speakable_char(char) else " " for char in text)

    # --- espaços e pontuação ----------------------------------------------
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"\s+([,.;:!?…])", r"\1", text)
    text = re.sub(r"([,;:])(?:\s*[,;:])+", r"\1", text)
    return text.strip()


async def list_voices() -> None:
    from edge_tts import list_voices as get_voices
    items = await get_voices()
    result = [
        {"shortName": item.get("ShortName"), "locale": item.get("Locale"),
         "localeName": item.get("LocaleName"), "gender": item.get("Gender"),
         "friendlyName": item.get("FriendlyName"), "status": item.get("Status")}
        for item in items
        if item.get("ShortName") in ALLOWED_VOICES
    ]
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.flush()


async def stream_audio(text: str, rate: str = RATE, voice: str = VOICE) -> None:
    from edge_tts import Communicate
    text = sanitize_text(text)
    if not text:
        raise ValueError("empty_speech_text")
    if rate not in ALLOWED_RATES:
        raise ValueError("invalid_rate")
    if voice not in ALLOWED_VOICES:
        raise ValueError("invalid_voice")
    communicate = Communicate(text, voice=voice, rate=ALLOWED_RATES[rate], pitch=PITCH)
    try:
        async for message in communicate.stream():
            if message.get("type") == "audio":
                sys.stdout.buffer.write(message["data"])
                sys.stdout.buffer.flush()
    except BrokenPipeError:
        return


def _read_payload() -> dict:
    """Lê o JSON do stdin garantindo UTF-8.

    `sys.stdin.reconfigure` resolve no Python 3.7+; nos demais casos o JSON
    chega com escapes ASCII (o servidor manda assim) e `json.loads` não
    depende da codificação do stdio.
    """
    reconfigure = getattr(sys.stdin, "reconfigure", None)
    if callable(reconfigure):
        try:
            reconfigure(encoding="utf-8")
        except (ValueError, OSError):
            pass
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict):
        raise ValueError("invalid_request")
    return payload


async def self_check() -> None:
    """Diagnóstico de codificação: o `npm run doctor` usa isto.

    Devolve o que o worker REALMENTE recebeu. Se `roundTrip` for falso, a
    acentuação foi corrompida no caminho até o motor — o que muda a pronúncia.
    """
    probe = "A inteligência está ótima, eleições e português."
    result = {
        "stdinEncoding": getattr(sys.stdin, "encoding", None),
        "localeEncoding": __import__("locale").getpreferredencoding(False),
        "interpreted": __import__("sys").flags.utf8_mode and "utf8-mode" or "locale",
        "received": None,
        "sanitized": None,
        "roundTrip": False,
    }
    try:
        payload = _read_payload()
        text = payload.get("text")
        if isinstance(text, str):
            result["received"] = text
            result["sanitized"] = sanitize_text(text)
            result["roundTrip"] = text.strip() == probe and sanitize_text(text).strip() == probe
    except Exception as exc:  # noqa: BLE001 - relatório, não fluxo
        result["error"] = type(exc).__name__
    sys.stdout.write(json.dumps(result, ensure_ascii=True))
    sys.stdout.flush()


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--list-voices", action="store_true")
    parser.add_argument("--self-check", action="store_true")
    args = parser.parse_args()
    try:
        if args.list_voices:
            await list_voices()
            return
        if args.self_check:
            await self_check()
            return
        payload = _read_payload()
        if not isinstance(payload.get("text"), str):
            raise ValueError("invalid_request")
        extra = set(payload) - {"text", "rate", "voice"}
        if extra:
            raise ValueError("invalid_request")
        rate = payload.get("rate", RATE)
        voice = payload.get("voice", VOICE)
        if not isinstance(rate, str):
            raise ValueError("invalid_rate")
        if not isinstance(voice, str):
            raise ValueError("invalid_voice")
        await stream_audio(payload["text"], rate, voice)
    except Exception as exc:
        # Avoid writing user text, credentials, or service response details to logs.
        print(f"edge_tts_worker_error:{type(exc).__name__}", file=sys.stderr, flush=True)
        raise SystemExit(2)


if __name__ == "__main__":
    asyncio.run(main())
