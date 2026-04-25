from __future__ import annotations

from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field


class SyncState(str, Enum):
    untouched = "untouched"
    imported = "imported"
    changed = "changed"


class PilePoint(BaseModel):
    id: str
    sourceId: str | None = None
    x: float
    y: float
    sourceNumber: str | None = None
    number: str | None = None
    groupId: str | None = None
    locked: bool = False
    manualNumber: str | None = None
    syncState: SyncState = SyncState.imported


class PileGroup(BaseModel):
    id: str
    name: str
    color: str = "#2F80ED"


class NumberingSettings(BaseModel):
    start: int = 1
    prefix: str = ""
    suffix: str = ""
    step: int = 1


class GridSettings(BaseModel):
    enabled: bool = True
    spacing: float = 5.0
    color: str = "#2f2f2f"


class ViewSettings(BaseModel):
    backgroundColor: str = "#1e1e1e"
    zoom: float = 1.0
    panX: float = 0.0
    panY: float = 0.0


class OperationRecord(BaseModel):
    type: str
    timestamp: str
    details: dict = Field(default_factory=dict)


class PileProject(BaseModel):
    name: str = "Untitled project"
    points: list[PilePoint] = Field(default_factory=list)
    groups: list[PileGroup] = Field(default_factory=list)
    numberingSettings: NumberingSettings = Field(default_factory=NumberingSettings)
    gridSettings: GridSettings = Field(default_factory=GridSettings)
    viewSettings: ViewSettings = Field(default_factory=ViewSettings)
    operations: list[OperationRecord] = Field(default_factory=list)


class NumberingRowsRequest(BaseModel):
    points: list[PilePoint]
    groupId: str
    settings: NumberingSettings = Field(default_factory=NumberingSettings)
    rowTolerance: float = 1.0


class ValidateProjectResponse(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)


class CsvImportResponse(BaseModel):
    points: list[PilePoint]


class NumberingMethod(str, Enum):
    rows = "rows"
    route = "route"
    vector = "vector"
    manual = "manual"


class NumberingRequest(BaseModel):
    method: Literal["rows", "route", "vector", "manual"] = "rows"
    payload: NumberingRowsRequest
