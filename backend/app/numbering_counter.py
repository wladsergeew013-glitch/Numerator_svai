"""Shared, preflighted counter policy. Never modify a route on a failed plan."""
from app.schemas import NumberingSettings, PilePoint, SAFE_INTEGER


def safe_number(value: int) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or abs(value) > SAFE_INTEGER:
        raise ValueError('Number exceeds the safe integer range')
    return value


def number_route(route: list[PilePoint], settings: NumberingSettings, reserved: set[int] | None = None) -> int:
    occupied = reserved if reserved is not None else {p.number for p in route if (p.locked or p.manualNumber) and p.number is not None}
    value, step = safe_number(settings.startNumber), safe_number(settings.step)
    if step == 0:
        raise ValueError('Step must not be zero')
    plan = []
    for point in route:
        if point.manualNumber:
            if point.number is not None:
                value = safe_number(point.number) + step
            continue
        if point.locked:
            continue
        while value in occupied:
            value = safe_number(value + step)
        safe_number(value)
        plan.append((point, value))
        occupied.add(value)
        value += step
    for point, number in plan:
        point.number = number
    return value
