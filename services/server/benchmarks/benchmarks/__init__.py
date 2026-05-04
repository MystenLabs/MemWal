from .base import BenchmarkAdapter
from .locomo import LocomoBenchmark
from .longmemeval import LongMemEvalBenchmark

BENCHMARKS: dict[str, type[BenchmarkAdapter]] = {
    "locomo": LocomoBenchmark,
    "longmemeval": LongMemEvalBenchmark,
}

__all__ = ["BenchmarkAdapter", "BENCHMARKS"]
