"""Visitor-facing language selection; robot IDs and wire payloads stay unchanged."""
import re
from typing import Literal

Language = Literal["zh", "en"]
CJK = re.compile(r"[\u3400-\u9fff]")
LATIN = re.compile(r"[A-Za-z]+")


def language_of(text: str, previous: Language = "zh") -> Language:
    if re.search(r"(?:speak|reply|respond|answer) (?:in )?english|english please|(?:用|说|讲)(?:英语|英文)", text, re.I):
        return "en"
    if re.search(r"(?:speak|reply|respond|answer) (?:in )?(?:chinese|mandarin)|chinese please|(?:用|说|讲)中文", text, re.I):
        return "zh"
    han, words = len(CJK.findall(text)), LATIN.findall(text)
    if han:
        # English sentences can contain a Chinese product name; a Chinese sentence
        # with an English brand name should still receive a Chinese answer.
        return "en" if len(words) >= 3 and len(words) >= han else "zh"
    return "en" if words else previous


def tts_language(text: str) -> str:
    han, latin = bool(CJK.search(text)), bool(LATIN.search(text))
    return "Auto" if han and latin else "English" if latin else "Chinese"


def item_label(item, language: Language) -> str:
    return (item.name_en or item.name) if language == "en" else item.name


def order_label(lines, items, language: Language) -> str:
    separator = ", " if language == "en" else "、"
    return separator.join(f"{item_label(items[line.item_id], language)} × {line.count}" for line in lines)


def robot_error_text(error, language: Language) -> str:
    if language == "zh":
        return str(error)
    return {
        "busy": "The robot is busy. Please wait for the current task to finish.",
        "unknown_item": "That item isn't in our shelf catalog. Please choose an available item.",
        "out_of_stock": "There isn't enough stock for that order. Please choose something else.",
        "recovery_required": "The robot needs an on-site check. Please ask a member of staff.",
        "robot_offline": "The robot is offline. Please ask a member of staff.",
        "stop_unavailable": "I cannot stop this robot remotely. Please ask on-site staff for help.",
    }.get(error.code, "I couldn't complete that request. Please ask a member of staff for help.")
