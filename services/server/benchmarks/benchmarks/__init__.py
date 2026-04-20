from .base import BenchmarkAdapter
from .locomo import LocomoBenchmark
from .longmemeval import LongMemEvalBenchmark
from .convomem import ConvoMemBenchmark

BENCHMARKS: dict[str, type[BenchmarkAdapter]] = {
    "locomo": LocomoBenchmark,
    "longmemeval": LongMemEvalBenchmark,
    "convomem": ConvoMemBenchmark,
}

__all__ = ["BenchmarkAdapter", "BENCHMARKS"]
