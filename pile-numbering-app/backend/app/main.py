from __future__ import annotations

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

from app.io_project import import_points_from_csv
from app.numbering.numbering_rows import apply_numbering_rows
from app.schemas import (
    CsvImportResponse,
    NumberingRowsRequest,
    PileProject,
    ValidateProjectResponse,
)

app = FastAPI(title="Pile Numbering API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/import/csv", response_model=CsvImportResponse)
async def import_csv(file: UploadFile = File(...)) -> CsvImportResponse:
    if not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="Only CSV files are supported")
    content = await file.read()
    return import_points_from_csv(content)


@app.post("/api/projects/validate", response_model=ValidateProjectResponse)
def validate_project(project: PileProject) -> ValidateProjectResponse:
    errors: list[str] = []
    point_ids = set()

    for p in project.points:
        if p.id in point_ids:
            errors.append(f"Duplicate point id: {p.id}")
        point_ids.add(p.id)

    group_ids = {g.id for g in project.groups}
    for p in project.points:
        if p.groupId and p.groupId not in group_ids:
            errors.append(f"Point {p.id} has unknown groupId {p.groupId}")

    return ValidateProjectResponse(valid=len(errors) == 0, errors=errors)


@app.post("/api/numbering/rows")
def numbering_rows(request: NumberingRowsRequest) -> dict[str, list]:
    updated_points = apply_numbering_rows(request)
    return {"points": [p.model_dump() for p in updated_points]}
