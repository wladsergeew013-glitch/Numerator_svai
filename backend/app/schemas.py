from __future__ import annotations

from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, Field, field_validator


class SyncState(str, Enum):
    unchanged = "unchanged"
    added = "added"
    moved = "moved"
    deleted = "deleted"
    conflict = "conflict"


class NumberingMethod(str, Enum):
    rows = "rows"
    columns = "columns"
    route = "route"
    vector = "vector"
    manual = "manual"


class NumberingMode(str, Enum):
    global_sequential = "global_sequential"
    per_group = "per_group"


class NumberTextMode(str, Enum):
    auto = "auto"
    manual = "manual"


class SelectionDragMode(str, Enum):
    left_add_right_subtract = "left_add_right_subtract"
    left_subtract_right_add = "left_subtract_right_add"


class Point2D(BaseModel):
    x: float
    y: float


class PilePoint(BaseModel):
    # Внутренний id точки. Не является номером сваи и не должен меняться при перенумерации.
    id: str = Field(default_factory=lambda: f"p-{uuid4().hex[:12]}")
    sourceId: str | None = None
    x: float
    y: float

    # Номер из исходной выгрузки и текущий итоговый номер.
    sourceNumber: str | int | None = None
    number: int | None = None

    groupId: str | None = None
    locked: bool = False
    manualNumber: bool = False
    syncState: SyncState = SyncState.added

    meta: dict[str, Any] = Field(default_factory=dict)


class NumberingManualLink(BaseModel):
    fromId: str
    toId: str


class NumberingSettings(BaseModel):
    method: NumberingMethod = NumberingMethod.rows
    startNumber: int = 1
    step: int = 1

    # Для rows/columns.
    rowTolerance: float = 250.0
    columnTolerance: float = 250.0
    direction: Literal[
        "left_to_right_top_to_bottom",
        "right_to_left_top_to_bottom",
        "left_to_right_bottom_to_top",
        "right_to_left_bottom_to_top",
        "snake_rows_left_top",
        "snake_rows_right_top",
        "snake_columns_top_left",
        "snake_columns_bottom_left",
    ] = "left_to_right_top_to_bottom"

    # Для route/vector.
    startPointId: str | None = None
    endPointId: str | None = None
    optimize: bool = True
    vectorPath: list[Point2D] = Field(default_factory=list)
    manualLinks: list[NumberingManualLink] = Field(default_factory=list)
    maxDistanceToPath: float = 1000.0

    # Для ручной нумерации.
    preserveManual: bool = True
    freezeAfterManualEdit: bool = True

    @field_validator("rowTolerance", "columnTolerance", "maxDistanceToPath")
    @classmethod
    def positive_float(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("Value must be positive")
        return value


class PileGroup(BaseModel):
    id: str = Field(default_factory=lambda: f"g-{uuid4().hex[:8]}")
    name: str
    order: int = 1
    pipelineId: str | None = None
    color: str = "#2F80ED"
    visible: bool = True
    locked: bool = False
    numbering: NumberingSettings = Field(default_factory=NumberingSettings)
    meta: dict[str, Any] = Field(default_factory=dict)


class NumberingPipeline(BaseModel):
    id: str = Field(default_factory=lambda: f"pipeline-{uuid4().hex[:8]}")
    name: str = "Пайплайн 1"
    order: int = 1

class GridSettings(BaseModel):
    enabled: bool = True
    axesEnabled: bool = True
    majorStep: float = 1000.0
    minorStep: float = 250.0
    color: str = "#334155"
    minorColor: str = "#1f2937"
    axisColor: str = "#94a3b8"
    snap: bool = False


class ViewSettings(BaseModel):
    backgroundColor: str = "#111827"
    zoom: float = 0.05
    panX: float = 0.0
    panY: float = 0.0

    # Текст нумерации свай.
    numberTextMode: NumberTextMode = NumberTextMode.auto
    numberTextColor: str = "#ffffff"
    numberTextStrokeColor: str = "#020617"
    numberTextStrokeEnabled: bool = False
    numberTextStrokeWidth: float = 0.0
    numberTextFontSize: float = 13.0
    numberTextFontFamily: str = "Tahoma, Segoe UI, Arial, sans-serif"
    numberTextBrightness: float = 1.0
    numberTextBubbleEnabled: bool = False
    showPointNumbers: bool = True
    highlightUnnumbered: bool = True
    showNumberingPreview: bool = True
    markerTextColor: str = "#ffffff"
    markerTextStrokeColor: str = '#020617'
    markerTextStrokeEnabled: bool = False
    markerTextStrokeWidth: float = 0.0
    markerTextFontSize: float = 12.0
    markerTextFontFamily: str = 'Tahoma, Segoe UI, Arial, sans-serif'
    markerTextBrightness: float = 1.0
    markerTextBubbleEnabled: bool = False
    showMarkerLabels: bool = True
    groupOutlineStrokeColor: str = "#64748b"
    groupOutlineFillColor: str = "rgba(96,165,250,0.035)"
    groupOutlineStrokeWidth: float = 1.7
    groupOutlineDashSize: float = 10.0
    groupOutlinePadding: float = 28.0
    groupOutlineSnapPx: float = 54.0
    groupOutlineSimplifyPx: float = 16.0
    previewAutoLineColor: str = "#38bdf8"
    previewAutoArrowColor: str = "#67e8f9"
    previewManualLineColor: str = "#f59e0b"
    previewManualArrowColor: str = "#facc15"
    previewSelectedLineColor: str = "#22d3ee"
    previewSelectedArrowColor: str = "#67e8f9"
    previewInvalidLinkColor: str = "#ef4444"
    previewLineWidth: float = 2.0
    previewManualLineWidth: float = 4.0
    previewSelectedLineWidth: float = 4.5
    previewPointLabelColor: str = "#ffffff"
    previewPointLabelStrokeColor: str = "#020617"
    previewPointLabelFontSize: float = 12.0
    previewPointLabelStrokeWidth: float = 0.0
    previewPointLabelBrightness: float = 1.0
    previewPointLabelBubbleEnabled: bool = False
    previewPointLabelBubbleColor: str = "#020617"
    numberTextBubbleColor: str = "#020617"
    numberTextBubbleStrokeColor: str = "#334155"
    markerCalloutBackgroundColor: str = "rgba(15,23,42,0.82)"
    markerCalloutBorderColor: str = "#64748b"
    markerLeaderLineColor: str = "#64748b"
    selectionDragMode: SelectionDragMode = SelectionDragMode.left_add_right_subtract


class ProjectInfo(BaseModel):
    id: str = Field(default_factory=lambda: f"project-{uuid4().hex[:12]}")
    name: str = "Untitled project"
    units: str = "mm"
    createdAt: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    updatedAt: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    # Имя файла проекта в локальной папке projects. Для нового проекта из CSV = None до первого сохранения.
    fileName: str | None = None
    # Имя исходного файла, из которого проект был создан/открыт.
    sourceFileName: str | None = None


class OperationRecord(BaseModel):
    id: str = Field(default_factory=lambda: f"op-{uuid4().hex[:12]}")
    type: str
    timestamp: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    payload: dict[str, Any] = Field(default_factory=dict)


class PileProject(BaseModel):
    schemaVersion: int = 1
    project: ProjectInfo = Field(default_factory=ProjectInfo)
    points: list[PilePoint] = Field(default_factory=list)
    groups: list[PileGroup] = Field(default_factory=list)
    pipelines: list[NumberingPipeline] = Field(default_factory=lambda: [NumberingPipeline(id="pipeline-main", name="Пайплайн 1", order=1)])
    numberingMode: NumberingMode = NumberingMode.global_sequential
    gridSettings: GridSettings = Field(default_factory=GridSettings)
    viewSettings: ViewSettings = Field(default_factory=ViewSettings)
    operations: list[OperationRecord] = Field(default_factory=list)

    # Обратная совместимость с первым каркасом Codex, где было name на верхнем уровне.
    @property
    def name(self) -> str:
        return self.project.name


class CsvImportResponse(BaseModel):
    points: list[PilePoint]


class ValidateProjectResponse(BaseModel):
    valid: bool
    errors: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class NumberingRowsRequest(BaseModel):
    points: list[PilePoint]
    groups: list[PileGroup] = Field(default_factory=list)
    groupId: str | None = None
    settings: NumberingSettings = Field(default_factory=NumberingSettings)
    numberingMode: NumberingMode = NumberingMode.global_sequential


class NumberingResponse(BaseModel):
    points: list[PilePoint]


class LocalProjectInfo(BaseModel):
    fileName: str
    name: str
    updatedAt: str | None = None
    pointsCount: int = 0
    groupsCount: int = 0


class LocalProjectListResponse(BaseModel):
    projects: list[LocalProjectInfo] = Field(default_factory=list)


class LocalProjectSaveResponse(BaseModel):
    saved: bool
    fileName: str
    name: str


class UserIconInfo(BaseModel):
    fileName: str
    url: str
    contentType: str | None = None
    sizeBytes: int = 0


class UserIconListResponse(BaseModel):
    icons: list[UserIconInfo] = Field(default_factory=list)


class UserIconUploadResponse(BaseModel):
    icon: UserIconInfo


class PanelStateConfig(BaseModel):
    x: float | None = None
    y: float | None = None
    width: float | None = None
    height: float | None = None
    dock: str | None = None


class AutosaveSettingsConfig(BaseModel):
    enabled: bool = False
    intervalMinutes: float = 5.0
    folderPath: str | None = None


class UserConfig(BaseModel):
    """Persistent UI config stored on disk next to EXE or in project config folder."""
    projectName: str | None = None
    gridSettings: dict[str, Any] = Field(default_factory=dict)
    viewSettings: dict[str, Any] = Field(default_factory=dict)
    groupManagerVisible: bool | None = None
    groupManagerDock: str | None = None
    groupManagerCollapsed: bool | None = None
    autoAssignSelection: bool | None = None
    collapsedGroupIds: list[str] = Field(default_factory=list)
    toolbarHeight: float | None = None
    commandIcons: dict[str, str] = Field(default_factory=dict)
    panels: dict[str, PanelStateConfig] = Field(default_factory=dict)
    autosaveSettings: AutosaveSettingsConfig = Field(default_factory=AutosaveSettingsConfig)

