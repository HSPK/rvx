from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RvxSettings:
    """Configure an explicitly owned native engine and storage directory."""

    directory: Path
    hot_capacity: int = 1_000_000
    scrape_concurrency: int = 256
    enabled: bool = True

    def __post_init__(self) -> None:
        """Reject invalid native capacity settings before opening storage."""
        if self.hot_capacity < 1:
            raise ValueError("hot_capacity must be positive")
        if self.scrape_concurrency < 1:
            raise ValueError("scrape_concurrency must be positive")
