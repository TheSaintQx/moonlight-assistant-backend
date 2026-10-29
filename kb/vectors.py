"""
NumPy vector index. Загружает vectors.npy если есть.
Пока пустой — будет заполнен скриптом embed.py.
"""
import numpy as np
import pathlib
from typing import Optional

class VectorIndex:
    def __init__(self, npy_path: pathlib.Path):
        self.ids: list[str] = []
        self.mat: Optional[np.ndarray] = None
        if npy_path.exists():
            try:
                data = np.load(npy_path, allow_pickle=True)
                self.ids = [str(x) for x in data["ids"]]
                self.mat = data["vecs"].astype(np.float32)
                norms = np.linalg.norm(self.mat, axis=1, keepdims=True)
                norms[norms == 0] = 1
                self.mat = self.mat / norms
            except Exception:
                self.mat = None
                self.ids = []

    def search(self, query_vec: np.ndarray, top_k: int = 10) -> list[tuple[str, float]]:
        if self.mat is None or len(self.mat) == 0:
            return []
        qv = query_vec.astype(np.float32)
        qv_norm = np.linalg.norm(qv)
        if qv_norm > 0:
            qv = qv / qv_norm
        scores = self.mat @ qv
        idx = np.argpartition(scores, -top_k)[-top_k:]
        results = [(self.ids[i], float(scores[i])) for i in sorted(idx, key=lambda x: -scores[x])]
        return results
