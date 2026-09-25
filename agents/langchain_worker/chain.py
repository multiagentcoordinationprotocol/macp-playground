"""LangChain growth analysis chain.

When langchain-openai is installed and OPENAI_API_KEY is set, this builds a real
LLM-powered chain. Otherwise, falls back to deterministic logic.
"""

import json
import os
from typing import Any, Dict

try:
    from mappers import score_by_domain
except ImportError:
    from .mappers import score_by_domain

JsonDict = Dict[str, Any]


def _score_result(inputs: JsonDict) -> JsonDict:
    """Delegate to mappers.score_by_domain — the single implementation the
    framework-available (no-API-key) and framework-unavailable fallback paths
    both call, eliminating what were two duplicate inline copies of this
    branching logic (plans/example-agent-domain-scoring.md Phase 2)."""
    domain = inputs.get('domain', 'fraud')
    recommendation, confidence, reason = score_by_domain(domain, inputs)
    return {'recommendation': recommendation, 'confidence': confidence, 'reason': reason}


try:
    from langchain_openai import ChatOpenAI
    from langchain_core.prompts import ChatPromptTemplate
    from langchain_core.runnables import RunnableLambda

    def _build_llm_chain():
        """Build a LangChain chain with ChatOpenAI for growth analysis."""
        api_key = os.environ.get('OPENAI_API_KEY', '')
        if not api_key:
            return None

        llm = ChatOpenAI(model='gpt-4o-mini', temperature=0, api_key=api_key)

        prompt = ChatPromptTemplate.from_messages([
            ('system',
             'You are a growth analyst evaluating whether a transaction should be approved, '
             'reviewed, or blocked from a customer value and revenue perspective. '
             'Balance fraud risk against customer experience and retention. '
             'Respond with ONLY a JSON object (no markdown): '
             '{{"recommendation": "APPROVE"|"REVIEW"|"BLOCK", "confidence": 0.0-1.0, '
             '"reason": "brief explanation", "factors": ["factor1", "factor2"]}}'),
            ('human',
             'Transaction: ${transaction_amount}\n'
             'VIP customer: {is_vip_customer}\n'
             'Account age: {account_age_days} days\n'
             'Device trust: {device_trust_score}\n'
             'Prior chargebacks: {prior_chargebacks}'),
        ])

        def invoke_with_usage(inputs: JsonDict) -> JsonDict:
            chain = prompt | llm
            response = chain.invoke(inputs)

            usage = response.usage_metadata or {}
            token_usage = {
                'promptTokens': usage.get('input_tokens', 0),
                'completionTokens': usage.get('output_tokens', 0),
                'model': 'gpt-4o-mini',
            }

            try:
                content = response.content.strip()
                if content.startswith('```'):
                    content = content.split('\n', 1)[1].rsplit('```', 1)[0].strip()
                parsed = json.loads(content)
                return {
                    'recommendation': parsed.get('recommendation', 'REVIEW').upper(),
                    'confidence': float(parsed.get('confidence', 0.8)),
                    'reason': parsed.get('reason', 'LLM-based growth assessment'),
                    'factors': parsed.get('factors', []),
                    'token_usage': token_usage,
                }
            except (json.JSONDecodeError, ValueError):
                return {
                    'recommendation': 'REVIEW',
                    'confidence': 0.7,
                    'reason': str(response.content)[:200],
                    'factors': [],
                    'token_usage': token_usage,
                }

        return RunnableLambda(invoke_with_usage)

    def build_agent():
        """Build a LangChain chain — LLM-powered if API key is available."""
        llm_chain = _build_llm_chain()
        if llm_chain:
            return llm_chain
        return RunnableLambda(_score_result)

    HAS_LANGCHAIN = True

except ImportError:

    HAS_LANGCHAIN = False

    def build_agent():
        """Fallback: returns a callable that mimics chain.invoke()."""

        class FallbackChain:
            def invoke(self, inputs: JsonDict) -> JsonDict:
                return _score_result(inputs)

        return FallbackChain()
