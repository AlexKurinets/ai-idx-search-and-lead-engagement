"""A small OData v4 subset: enough $filter, $orderby and $select for RESO replication.

Supported filter grammar:

    expr    := or_expr
    or_expr := and_expr ("or" and_expr)*
    and_expr:= unary ("and" unary)*
    unary   := "not" unary | "(" expr ")" | comparison
    comparison := Field op literal        op in eq ne gt ge lt le

Literals are quoted strings ('it''s'), numbers, true/false/null and unquoted
DateTimeOffset values such as 2026-10-16T12:00:00.000Z.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

Record = dict[str, Any]
Predicate = Callable[[Record], bool]


class ODataError(ValueError):
    pass


_TOKEN = re.compile(
    r"""
    (?P<ws>\s+)
  | (?P<lparen>\()
  | (?P<rparen>\))
  | (?P<string>'(?:[^']|'')*')
  | (?P<datetime>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2}))
  | (?P<number>-?\d+(?:\.\d+)?)
  | (?P<word>[A-Za-z_][A-Za-z0-9_]*)
    """,
    re.VERBOSE,
)

_OPS = {"eq", "ne", "gt", "ge", "lt", "le"}


@dataclass
class _Tok:
    kind: str
    value: Any


def parse_datetime(text: str) -> datetime:
    value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return value


def format_datetime(value: datetime) -> str:
    """RESO timestamps at millisecond precision, the precision this server stores."""
    return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.") + f"{value.microsecond // 1000:03d}Z"


def _tokenize(text: str) -> list[_Tok]:
    out: list[_Tok] = []
    pos = 0
    while pos < len(text):
        m = _TOKEN.match(text, pos)
        if not m:
            raise ODataError(f"unexpected character at {pos}: {text[pos:pos + 12]!r}")
        pos = m.end()
        kind = m.lastgroup
        raw = m.group(kind)
        if kind == "ws":
            continue
        if kind == "string":
            out.append(_Tok("literal", raw[1:-1].replace("''", "'")))
        elif kind == "datetime":
            out.append(_Tok("literal", parse_datetime(raw)))
        elif kind == "number":
            out.append(_Tok("literal", float(raw) if "." in raw else int(raw)))
        elif kind == "word":
            low = raw.lower()
            if low in {"and", "or", "not"} or low in _OPS:
                out.append(_Tok(low, low))
            elif low in {"true", "false"}:
                out.append(_Tok("literal", low == "true"))
            elif low == "null":
                out.append(_Tok("literal", None))
            else:
                out.append(_Tok("field", raw))
        else:
            out.append(_Tok(kind, raw))
    return out


def _coerce(field_value: Any, literal: Any) -> tuple[Any, Any]:
    if isinstance(literal, datetime) and isinstance(field_value, str):
        return parse_datetime(field_value), literal
    if isinstance(literal, int | float) and isinstance(field_value, str):
        try:
            return float(field_value), literal
        except ValueError:
            return field_value, str(literal)
    return field_value, literal


def _compare(op: str, left: Any, right: Any) -> bool:
    if op == "eq":
        return left == right
    if op == "ne":
        return left != right
    if left is None or right is None:
        return False
    if op == "gt":
        return left > right
    if op == "ge":
        return left >= right
    if op == "lt":
        return left < right
    return left <= right


class _Parser:
    def __init__(self, tokens: list[_Tok]):
        self.toks = tokens
        self.i = 0

    def peek(self) -> _Tok | None:
        return self.toks[self.i] if self.i < len(self.toks) else None

    def take(self, kind: str | None = None) -> _Tok:
        tok = self.peek()
        if tok is None or (kind and tok.kind != kind):
            raise ODataError(f"expected {kind or 'token'} at position {self.i}")
        self.i += 1
        return tok

    def parse(self) -> Predicate:
        pred = self.or_expr()
        if self.peek() is not None:
            raise ODataError(f"unexpected token {self.peek().value!r}")
        return pred

    def or_expr(self) -> Predicate:
        parts = [self.and_expr()]
        while self.peek() and self.peek().kind == "or":
            self.take()
            parts.append(self.and_expr())
        return parts[0] if len(parts) == 1 else (lambda r, ps=parts: any(p(r) for p in ps))

    def and_expr(self) -> Predicate:
        parts = [self.unary()]
        while self.peek() and self.peek().kind == "and":
            self.take()
            parts.append(self.unary())
        return parts[0] if len(parts) == 1 else (lambda r, ps=parts: all(p(r) for p in ps))

    def unary(self) -> Predicate:
        tok = self.peek()
        if tok is None:
            raise ODataError("unexpected end of filter")
        if tok.kind == "not":
            self.take()
            inner = self.unary()
            return lambda r: not inner(r)
        if tok.kind == "lparen":
            self.take()
            inner = self.or_expr()
            self.take("rparen")
            return inner
        field = self.take("field").value
        op_tok = self.take()
        if op_tok.kind not in _OPS:
            raise ODataError(f"unsupported operator {op_tok.value!r}")
        literal = self.take("literal").value
        op = op_tok.kind

        def pred(r: Record) -> bool:
            left, right = _coerce(r.get(field), literal)
            try:
                return _compare(op, left, right)
            except TypeError:
                return False

        return pred


def compile_filter(text: str | None) -> Predicate:
    if not text or not text.strip():
        return lambda r: True
    return _Parser(_tokenize(text)).parse()


def parse_orderby(text: str | None) -> list[tuple[str, bool]]:
    """Returns [(field, descending)]."""
    if not text:
        return []
    out = []
    for part in text.split(","):
        bits = part.strip().split()
        if not bits:
            continue
        if len(bits) > 2 or (len(bits) == 2 and bits[1].lower() not in {"asc", "desc"}):
            raise ODataError(f"bad $orderby term {part!r}")
        out.append((bits[0], len(bits) == 2 and bits[1].lower() == "desc"))
    return out


def sort_key(orderby: list[tuple[str, bool]]):
    """Sort key for ascending terms; descending terms are handled by stable multi-pass sorting."""

    def key(field: str):
        def k(r: Record):
            v = r.get(field)
            if isinstance(v, str) and field.endswith("Timestamp"):
                return (0, parse_datetime(v))
            return (1, "") if v is None else (0, v)

        return k

    return [(key(f), desc) for f, desc in orderby]


def apply_orderby(records: list[Record], orderby: list[tuple[str, bool]]) -> list[Record]:
    out = list(records)
    for k, desc in reversed(sort_key(orderby)):
        out.sort(key=k, reverse=desc)
    return out
