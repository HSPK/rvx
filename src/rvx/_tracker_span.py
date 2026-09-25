from __future__ import annotations

import functools
import inspect
import json
import time
from collections.abc import Mapping
from contextvars import ContextVar
from typing import TYPE_CHECKING, Any

from ._tracker_values import encode_json, json_value

if TYPE_CHECKING:
    from .tracker import Run


_stack: ContextVar[tuple[tuple[int, str], ...]] = ContextVar(
    "rvx_tracker_spans",
    default=(),
)


def reset_after_fork() -> None:
    global _stack
    _stack = ContextVar("rvx_tracker_spans", default=())


class Span:
    """SDK context object; timing and aggregation are committed by Rust."""

    def __init__(
        self,
        run: Run | None,
        name: str,
        attributes: Mapping[str, Any],
        step: int | None = None,
    ):
        self.run = run
        self.name = name
        self.attributes = dict(attributes)
        self.step = step
        self._path = ""
        self._native_span = None
        self._fallback_started_ns = 0
        self._ended = False
        self._identity = id(self)
        self._duration_ms = 0.0

    @property
    def duration_ms(self) -> float:
        """Return the completed duration, or zero before the span ends."""
        return self._duration_ms

    def begin(self) -> Span:
        if self._native_span is not None or self._fallback_started_ns:
            return self
        stack = _stack.get()
        self._path = "/".join([*(name for _, name in stack), self.name])
        _stack.set((*stack, (self._identity, self.name)))
        if self.run is not None:
            self._native_span = self.run._native.start_span_json(
                self._path,
                self.step,
            )
        else:
            self._fallback_started_ns = time.perf_counter_ns()
        return self

    def set(self, **attributes: Any) -> Span:
        self.attributes.update(attributes)
        return self

    def end(self, error: BaseException | None = None) -> float:
        if self._ended:
            return 0.0
        if self._native_span is None and not self._fallback_started_ns:
            self.begin()
        self._ended = True
        _stack.set(tuple(part for part in _stack.get() if part[0] != self._identity))
        if self._native_span is not None:
            result = json.loads(
                self._native_span.end_json(
                    encode_json(json_value(self.attributes)),
                    None if error is None else type(error).__name__,
                )
            )
            self._duration_ms = result["duration_ms"]
        else:
            self._duration_ms = (
                time.perf_counter_ns() - self._fallback_started_ns
            ) / 1_000_000
        return self._duration_ms

    def __enter__(self) -> Span:
        return self.begin()

    def __exit__(self, kind, value, traceback) -> bool:
        del kind, traceback
        self.end(value)
        return False

    async def __aenter__(self) -> Span:
        return self.begin()

    async def __aexit__(self, kind, value, traceback) -> bool:
        return self.__exit__(kind, value, traceback)

    def __call__(self, function):
        if inspect.iscoroutinefunction(function):

            @functools.wraps(function)
            async def async_wrapper(*args, **kwargs):
                async with Span(
                    self.run or _current_run(),
                    self.name,
                    self.attributes,
                    self.step,
                ):
                    return await function(*args, **kwargs)

            return async_wrapper

        @functools.wraps(function)
        def wrapper(*args, **kwargs):
            with Span(
                self.run or _current_run(),
                self.name,
                self.attributes,
                self.step,
            ):
                return function(*args, **kwargs)

        return wrapper


def _current_run():
    from .tracker import get_run

    return get_run()
