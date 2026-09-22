"""Future learning contract only: no trained model or synthetic predictions are shipped.

Training/validation splits must use whole field IDs, never random pairs from one field.
Positions are isotropically normalized; absolute drawing size is not a learning feature.
"""
from typing import Literal, Protocol
import math

from pydantic import BaseModel, Field
from app.schemas import PilePoint


class LabeledField(BaseModel):
    schemaVersion: Literal[1] = 1
    fieldId: str = Field(min_length=1)
    points: list[PilePoint] = Field(min_length=2)
    # Human-confirmed labels only; nulls are unknown, not a negative training class.
    confirmed: bool = False


class FieldPartitionModel(Protocol):
    """A future MLP/GNN adapter must obey the same preview ID contract."""
    def predict(self, points: list[PilePoint]) -> list[list[str]]: ...


def normalized_training_field(field: LabeledField) -> dict:
    if not field.confirmed:
        raise ValueError('Для обучения нужна подтверждённая человеком разметка.')
    points = sorted(field.points, key=lambda p: p.id)
    if len({p.id for p in points}) != len(points):
        raise ValueError('Повторяются идентификаторы точек.')
    if any(not math.isfinite(p.x) or not math.isfinite(p.y) for p in points):
        raise ValueError('Некорректные координаты.')
    groups = {p.groupId for p in points if p.groupId is not None}
    if len(groups) < 2:
        raise ValueError('Нужно хотя бы две подтверждённые группы для примеров границ.')
    cx = sum(p.x for p in points) / len(points)
    cy = sum(p.y for p in points) / len(points)
    scale = max(max(p.x for p in points) - min(p.x for p in points),
                max(p.y for p in points) - min(p.y for p in points))
    if scale <= 0:
        raise ValueError('Все точки имеют одинаковые координаты.')
    return {'schemaVersion': 1, 'fieldId': field.fieldId,
            'points': [{'id': p.id, 'x': (p.x-cx)/scale, 'y': (p.y-cy)/scale, 'groupId': p.groupId}
                       for p in points]}
