"""Conservative English order edits while a confirmation is pending.

Only complete, explicit edits change the pending list. Questions, unknown products,
negations and mixed instructions retain it and never count as approval.
"""
import re

from .domain import TaskLine, TaskRequest

LIMIT = "Each order can contain at most two items. Your current order is unchanged."
CLARIFY = 'Please name each item and quantity, for example "add one pack of chips" or "change it to two waters".'
NUMBERS = {"a": 1, "an": 1, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
           "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10, "zero": 0}
NUMBER = r"a|an|one|two|three|four|five|six|seven|eight|nine|ten|zero|\d+"
UNITS = r"bottles?|packs?|box(?:es)?|bags?|cartons?|pieces?|decks?|tubes?"


def normalized(text):
    return re.sub(r"\s+", " ", text.casefold().replace("’", "'")).strip(" .,!，。！")


def aliases(item):
    values = [item.name_en, *item.aliases_en, *item.aliases]
    return {v.casefold() for v in values if v and re.fullmatch(r"[a-zA-Z '\-]+", v)}


def count_of(value):
    count = int(value) if value.isdigit() else NUMBERS[value]
    if count not in (1, 2):
        raise ValueError(LIMIT)
    return count


def parse_items(text, items):
    text = normalized(text)
    if re.match(r"^(?:can|could|would|may)\b", text):
        text = text.rstrip("?")
    text = re.sub(r",?\s*please$", "", text).strip()
    text = re.sub(r"^please\s+", "", text)
    text = re.sub(r"^(?:(?:can|could|would) you (?:please )?)?(?:bring|get|fetch|give)(?: me| us)?\s+", "", text)
    text = re.sub(r"^(?:i(?:'d| would) like(?: to have)?|i (?:want|need)|(?:may|can|could) i have)\s+", "", text)
    counts = {}
    for part in re.split(r"\s+(?:and|plus)\s+|\s*,\s*", text):
        found = None
        for item in items.values():
            for alias in sorted(aliases(item), key=len, reverse=True):
                match = re.fullmatch(rf"(?:(?P<count>{NUMBER})\s+)?(?:(?:{UNITS})\s+(?:of\s+)?)?"
                                     + re.escape(alias), part)
                if match:
                    found = (item.id, count_of(match["count"] or "one"))
                    break
            if found:
                break
        if not found:
            raise ValueError(CLARIFY)
        key, count = found
        counts[key] = counts.get(key, 0) + count
    if not counts or sum(counts.values()) > 2:
        raise ValueError(LIMIT)
    return [TaskLine(item_id=key, count=count) for key, count in counts.items()]


def revise_english(text, current, items):
    text = normalized(text)
    if "?" in text or re.search(r"\b(?:or|but|if|unless|not|don't|do not|never)\b", text):
        raise ValueError(CLARIFY)
    text = re.sub(r"^(?:yes|ok|okay|actually|sure)[, ]+", "", text)
    text = re.sub(r"^please\s+", "", text)
    text = re.sub(r",?\s*please$", "", text).strip()
    add = re.fullmatch(r"(?:add|also (?:add|bring|get)|i also want)\s+(.+)", text)
    replace = re.fullmatch(r"(?:change (?:it|that|the order) to|replace (?:it|that|the order) with)\s+(.+)", text)
    remove = re.fullmatch(r"(?:remove|drop|take off)\s+(.+)", text)
    quantity = re.fullmatch(rf"make (?:it|that) ({NUMBER})(?: (?:items?|bottles?|packs?))?", text)
    more = re.fullmatch(rf"(?:add )?({NUMBER}) more", text)
    if quantity or more:
        if len(current) != 1:
            raise ValueError("Which item should I change? Please say its name.")
        count = count_of((quantity or more)[1]) + (current[0].count if more else 0)
        if count > 2:
            raise ValueError(LIMIT)
        return [TaskLine(item_id=current[0].item_id, count=count)]
    if not any((add, replace, remove)):
        return None
    proposed_text = (add or replace or remove)[1]
    if add:
        proposed_text = re.sub(rf"^({NUMBER}) more\s+", r"\1 ", proposed_text)
    proposed = parse_items(proposed_text, items)
    if remove:
        ids = {line.item_id for line in proposed}
        if not ids.issubset({line.item_id for line in current}):
            raise ValueError("That item is not in your current order.")
        remaining = [line.model_copy() for line in current if line.item_id not in ids]
        if not remaining:
            raise ValueError('That would remove the whole order. Say "cancel" to cancel it.')
        return remaining
    counts = {line.item_id: line.count for line in current} if add else {}
    for line in proposed:
        counts[line.item_id] = counts.get(line.item_id, 0) + line.count
    if sum(counts.values()) > 2:
        raise ValueError(LIMIT)
    return TaskRequest(items=[TaskLine(item_id=key, count=count) for key, count in counts.items()],
                       request_id="pending-edit").items
