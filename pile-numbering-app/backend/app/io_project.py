from __future__ import annotations

import csv
import io
import uuid

from app.schemas import CsvImportResponse, PilePoint, PileProject, SyncState


def import_points_from_csv(content: bytes) -> CsvImportResponse:
    decoded = content.decode("utf-8-sig")
    reader = csv.DictReader(io.StringIO(decoded))
    points: list[PilePoint] = []

    for row in reader:
        x = float(row.get("x", 0))
        y = float(row.get("y", 0))
        source_id = row.get("sourceId") or row.get("id") or str(uuid.uuid4())

        points.append(
            PilePoint(
                id=str(uuid.uuid4()),
                sourceId=source_id,
                x=x,
                y=y,
                sourceNumber=row.get("sourceNumber") or row.get("number"),
                number=None,
                groupId=None,
                locked=False,
                manualNumber=None,
                syncState=SyncState.imported,
            )
        )

    return CsvImportResponse(points=points)


def export_project_json(project: PileProject) -> dict:
    return project.model_dump()


def import_project_json(payload: dict) -> PileProject:
    return PileProject.model_validate(payload)
