"""
LLM-as-Judge evaluator.

Uses a FIXED prompt to score generated answers against ground truth.
The prompt must never change between runs or preset comparisons —
modifying it invalidates cross-run comparability.

Scoring follows the published benchmark methodology:
  4 dimensions (1-5 each) → mean → normalized to 0-100 (J-score).
"""

from __future__ import annotations

import json
import logging

from openai import OpenAI

from .types import Judgment

logger = logging.getLogger(__name__)

# ============================================================
# Fixed prompts — DO NOT MODIFY between runs
# ============================================================

JUDGE_SYSTEM_PROMPT = """You are an impartial evaluator scoring the quality of an AI assistant's answer about a user, based on their conversation history.

You will be given a question, the correct answer (ground truth), and a generated answer to evaluate.

Score each dimension from 1 (worst) to 5 (best):

1. factual_accuracy: Are the facts in the generated answer correct and consistent with the ground truth? Penalize fabricated or contradicted facts.
2. relevance: Does the generated answer directly address the question asked? Penalize tangential or off-topic content.
3. completeness: Does the generated answer cover all key aspects of the ground truth? Penalize missing important details.
4. contextual_appropriateness: Is the answer grounded in actual conversation history, not hallucinated? Penalize invented context.

Respond ONLY with a JSON object, no other text:
{"factual_accuracy": N, "relevance": N, "completeness": N, "contextual_appropriateness": N}"""

JUDGE_USER_TEMPLATE = """Question: {question}

Ground truth answer: {ground_truth}

Generated answer: {generated_answer}"""

ANSWER_SYSTEM_PROMPT = """You are an AI assistant answering questions about a user based on retrieved memories from past conversations.

Use ONLY the provided memories to answer. If the memories do not contain enough information to answer, say so explicitly. Do not fabricate information."""

ANSWER_USER_TEMPLATE = """Retrieved memories:
{memories}

Question: {question}

Answer concisely based only on the memories above."""

# ============================================================
# Answer-prompt VARIANTS — selectable via ANSWER_PROMPT_VARIANT
# ============================================================
# The JUDGE prompt above is frozen (cross-run comparability). The ANSWER prompt
# is the assistant being measured, so a *deliberate* A/B of answer prompts is a
# legitimate experiment as long as the judge is held fixed. `baseline` is
# byte-identical to the prompts above; `reasoning` licenses bounded multi-fact
# synthesis + inference (the diagnosis showed many failures are
# "facts retrieved but not connected", which the terse baseline suppresses).
# Default `baseline` — silent unless explicitly opted in.

REASONING_ANSWER_SYSTEM_PROMPT = """You are an AI assistant answering questions about a user based on retrieved memories from past conversations.

Reason carefully over the memories before answering:
- When the answer requires more than one fact, combine the relevant memories — this multi-step synthesis is expected and encouraged whenever the needed facts are present.
- Make reasonable inferences that follow from facts that ARE in the memories (e.g. dates, relationships, implications).
- Use general world knowledge ONLY to interpret memories that are present, never to invent facts about the user.

One firm boundary: if the memories never mention the specific thing the question asks about, say plainly that they do not contain that information. In that case do not substitute a related or adjacent fact about the same person or topic, and do not guess. This boundary is about whether the asked-about subject appears at all — it does not restrict combining or inferring from facts that ARE present."""

REASONING_ANSWER_USER_TEMPLATE = """Retrieved memories:
{memories}

Question: {question}

Think through which memories are relevant and how they combine, then give a concise final answer."""

_ANSWER_PROMPT_VARIANTS = {
    "baseline": (ANSWER_SYSTEM_PROMPT, ANSWER_USER_TEMPLATE),
    "reasoning": (REASONING_ANSWER_SYSTEM_PROMPT, REASONING_ANSWER_USER_TEMPLATE),
}


def resolve_answer_prompt(variant: str | None) -> tuple[str, str]:
    """Return (system, user_template) for the named answer-prompt variant.

    Unknown/empty → baseline (the byte-identical default), with a warn so a
    typo'd bench env can't silently read as the variant under test.
    """
    if variant is None or variant.strip() == "":
        return _ANSWER_PROMPT_VARIANTS["baseline"]
    key = variant.strip().lower()
    if key not in _ANSWER_PROMPT_VARIANTS:
        logger.warning(
            "ANSWER_PROMPT_VARIANT=%r unrecognized — using 'baseline'. "
            "Valid: %s", variant, ", ".join(_ANSWER_PROMPT_VARIANTS),
        )
        return _ANSWER_PROMPT_VARIANTS["baseline"]
    return _ANSWER_PROMPT_VARIANTS[key]


class LLMJudge:
    """Evaluates generated answers using an LLM judge with fixed prompts."""

    def __init__(
        self,
        judge_model: str,
        answer_model: str,
        api_key: str,
        api_base: str = "https://api.openai.com/v1",
        answer_prompt_variant: str | None = None,
    ):
        self.judge_model = judge_model
        self.answer_model = answer_model
        self._client = OpenAI(api_key=api_key, base_url=api_base)
        self.tokens_used = 0
        # Frozen judge; selectable ANSWER prompt (deliberate A/B). Resolved once
        # so a whole run uses one consistent variant.
        self.answer_prompt_variant = (answer_prompt_variant or "baseline").strip().lower()
        self._answer_system, self._answer_user_template = resolve_answer_prompt(answer_prompt_variant)

    def generate_answer(self, question: str, memories: list[str]) -> str:
        """
        Generate an answer using recalled memories as context.

        This simulates what an AI assistant would produce given the
        memories retrieved by /api/recall.
        """
        if not memories:
            return "I don't have enough information in my memories to answer this question."

        memories_text = "\n".join(f"- {m}" for m in memories)

        resp = self._client.chat.completions.create(
            model=self.answer_model,
            messages=[
                {"role": "system", "content": self._answer_system},
                {"role": "user", "content": self._answer_user_template.format(
                    memories=memories_text,
                    question=question,
                )},
            ],
            temperature=0.0,
            max_tokens=300,
        )

        self.tokens_used += resp.usage.total_tokens if resp.usage else 0
        return resp.choices[0].message.content.strip()

    def judge(self, question: str, ground_truth: str, generated_answer: str) -> Judgment:
        """
        Score a generated answer against ground truth.

        Returns a Judgment with 4 dimension scores (1-5) and a derived J-score (0-100).
        """
        resp = self._client.chat.completions.create(
            model=self.judge_model,
            messages=[
                {"role": "system", "content": JUDGE_SYSTEM_PROMPT},
                {"role": "user", "content": JUDGE_USER_TEMPLATE.format(
                    question=question,
                    ground_truth=ground_truth,
                    generated_answer=generated_answer,
                )},
            ],
            temperature=0.0,
            max_tokens=100,
            response_format={"type": "json_object"},
        )

        self.tokens_used += resp.usage.total_tokens if resp.usage else 0
        raw = resp.choices[0].message.content.strip()

        # Earlier behaviour: silently fall back to (1,1,1,1) = 5 J on parse
        # failure. That's a systematic downward bias on the aggregate score —
        # we'd rather miss the query entirely than score it 5/100.
        # `stage_eval` catches exceptions from this method and excludes the
        # affected query from the aggregate (returns None for that query).
        try:
            scores = json.loads(raw)
        except (json.JSONDecodeError, TypeError) as e:
            logger.warning(
                "Judge JSON parse failed (excluding from aggregate): %s — raw: %s",
                e, raw,
            )
            raise RuntimeError(f"judge JSON parse failed: {e}") from e

        # Validate required keys are present. Missing keys would default to 1
        # via .get(...) and produce the same downward bias as a parse failure;
        # treat them the same way.
        required = ("factual_accuracy", "relevance", "completeness", "contextual_appropriateness")
        missing = [k for k in required if k not in scores]
        if missing:
            logger.warning(
                "Judge response missing keys %s (excluding from aggregate): raw: %s",
                missing, raw,
            )
            raise RuntimeError(f"judge response missing keys: {missing}")

        return Judgment(
            factual_accuracy=_clamp(scores["factual_accuracy"]),
            relevance=_clamp(scores["relevance"]),
            completeness=_clamp(scores["completeness"]),
            contextual_appropriateness=_clamp(scores["contextual_appropriateness"]),
        )


def _clamp(value: int | float, low: int = 1, high: int = 5) -> int:
    """Clamp a score to [1, 5] range."""
    try:
        return max(low, min(high, int(value)))
    except (ValueError, TypeError):
        return low
