"""
Граф связей статей по links.
"""
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from kb.loader import KB

class KBGraph:
    def __init__(self, kb: "KB"):
        self._kb = kb

    def expand(self, seed_id: str, depth: int = 1) -> list[str]:
        seen = [seed_id]
        frontier = [seed_id]
        for _ in range(depth):
            next_frontier = []
            for s in frontier:
                art = self._kb.get(s)
                if not art:
                    continue
                for link in art.links:
                    if link not in seen:
                        seen.append(link)
                        next_frontier.append(link)
            frontier = next_frontier
        return seen
