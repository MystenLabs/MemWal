"""
LLM-as-Judge evaluator.

Uses a FIXED prompt to score generated answers against ground truth.
The prompt must never change between runs or preset comparisons —
modifying it invalidates cross-run comparability.

Scoring follows the Mem0 paper methodology:
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


class LLMJudge:
    """Evaluates generated answers using an LLM judge with fixed prompts."""

    def __init__(
        self,
        judge_model: str,
        answer_model: str,
        api_key: str,
        api_base: str = "https://api.openai.com/v1",
    ):
        self.judge_model = judge_model
        self.answer_model = answer_model
        self._client = OpenAI(api_key=api_key, base_url=api_base)
        self.tokens_used = 0

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
                {"role": "system", "content": ANSWER_SYSTEM_PROMPT},
                {"role": "user", "content": ANSWER_USER_TEMPLATE.format(
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

        try:
            scores = json.loads(raw)
            return Judgment(
                factual_accuracy=_clamp(scores.get("factual_accuracy", 1)),
                relevance=_clamp(scores.get("relevance", 1)),
                completeness=_clamp(scores.get("completeness", 1)),
                contextual_appropriateness=_clamp(scores.get("contextual_appropriateness", 1)),
            )
        except (json.JSONDecodeError, TypeError) as e:
            logger.warning("Failed to parse judge response: %s — raw: %s", e, raw)
            return Judgment(
                factual_accuracy=1,
                relevance=1,
                completeness=1,
                contextual_appropriateness=1,
            )


def _clamp(value: int | float, low: int = 1, high: int = 5) -> int:
    """Clamp a score to [1, 5] range."""
    try:
        return max(low, min(high, int(value)))
    except (ValueError, TypeError):
        return low
