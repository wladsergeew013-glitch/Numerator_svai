from __future__ import annotations

import csv
import io
from typing import Iterable
from uuid import uuid4

from app.schemas import CsvImportResponse, PilePoint, PileProject, SyncState


X_ALIASES = {"x", "х", "coordx", "coordinatex", "xcoord", "x_coordinate"}
Y_ALIASES = {"y", "у", "coordy", "coordinatey", "ycoord", "y_coordinate"}
N_ALIASES = {"number", "num", "n", "номер", "no", "sourceNumber", "source_number"}
ID_ALIASES = {"sourceid", "source_id", "id", "guid", "uuid"}


def _norm(value: str | None) -> str:
    return (value or "").strip().replace(" ", "").replace("-", "_").lower()


def _find_column(fieldnames: Iterable[str], aliases: set[str]) -> str | None:
    for name in fieldnames:
        if _norm(name) in {_norm(a) for a in aliases}:
            return name
    return None


def _read_csv_text(content: bytes) -> str:
    for encoding in ("utf-8-sig", "cp1251", "utf-8"):
        try:
            return content.decode(encoding)
        except UnicodeDecodeError:
            continue
    return content.decode("utf-8", errors="replace")


def _parse_float(value: str | None, row_number: int, col_name: str) -> float:
    if value is None:
        raise ValueError(f"Row {row_number}: missing {col_name}")
    cleaned = value.strip().replace(" ", "").replace(",", ".")
    if cleaned == "":
        raise ValueError(f"Row {row_number}: empty {col_name}")
    return float(cleaned)


def import_points_from_csv(content: bytes) -> CsvImportResponse:
    """Import CSV with headers X,Y,Number or without headers x,y,number.

    CSV remains an exchange format only. Internal point id is generated separately
    and is never equal to the pile number.
    """
    text = _read_csv_text(content)
    sample = text[:2048]
    dialect = csv.Sniffer().sniff(sample, delimiters=",;\t")
    has_header = csv.Sniffer().has_header(sample)

    points: list[PilePoint] = []

    if has_header:
        reader = csv.DictReader(io.StringIO(text), dialect=dialect)
        fieldnames = reader.fieldnames or []
        x_col = _find_column(fieldnames, X_ALIASES)
        y_col = _find_column(fieldnames, Y_ALIASES)
        n_col = _find_column(fieldnames, N_ALIASES)
        id_col = _find_column(fieldnames, ID_ALIASES)

        if not x_col or not y_col:
            raise ValueError(f"CSV must contain X and Y columns. Found: {fieldnames}")

        for idx, row in enumerate(reader, start=2):
            if not row or all((v or "").strip() == "" for v in row.values()):
                continue
            x = _parse_float(row.get(x_col), idx, x_col)
            y = _parse_float(row.get(y_col), idx, y_col)
            source_number = row.get(n_col).strip() if n_col and row.get(n_col) is not None else None
            source_id = row.get(id_col).strip() if id_col and row.get(id_col) else None
            if not source_id and source_number:
                source_id = str(source_number)

            points.append(
                PilePoint(
                    id=f"p-{uuid4().hex[:12]}",
                    sourceId=source_id,
                    x=x,
                    y=y,
                    sourceNumber=source_number,
                    number=None,
                    groupId=None,
                    locked=False,
                    manualNumber=False,
                    syncState=SyncState.added,
                )
            )
    else:
        reader2 = csv.reader(io.StringIO(text), dialect=dialect)
        for idx, row in enumerate(reader2, start=1):
            if not row or all(c.strip() == "" for c in row):
                continue
            if len(row) < 2:
                raise ValueError(f"Row {idx}: expected at least x,y")
            x = _parse_float(row[0], idx, "x")
            y = _parse_float(row[1], idx, "y")
            source_number = row[2].strip() if len(row) >= 3 and row[2].strip() else None
            source_id = str(source_number) if source_number else None
            points.append(
                PilePoint(
                    id=f"p-{uuid4().hex[:12]}",
                    sourceId=source_id,
                    x=x,
                    y=y,
                    sourceNumber=source_number,
                    number=None,
                    groupId=None,
                    locked=False,
                    manualNumber=False,
                    syncState=SyncState.added,
                )
            )

    return CsvImportResponse(points=points)


def export_project_json(project: PileProject) -> dict:
    # Project JSON stores domain data only. UI workspace settings live in config/user_config.json
    # or in a separately exported .pilenum-ui.json file.
    return project.model_dump(mode="json", exclude={"gridSettings", "viewSettings"})


def import_project_json(payload: dict) -> PileProject:
    return PileProject.model_validate(payload)
